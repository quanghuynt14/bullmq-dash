import { Database } from "bun:sqlite";
import { getConfig, type Config } from "../config.js";
import type { Context } from "../context.js";
import type { QueueStats } from "./queues.js";
import type { JobSchedulerSummary } from "./schedulers.js";

let db: Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  name TEXT,
  state TEXT NOT NULL,
  timestamp INTEGER,
  data_preview TEXT,
  removed_at INTEGER,
  PRIMARY KEY (queue, id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);
CREATE INDEX IF NOT EXISTS idx_jobs_timestamp ON jobs(timestamp);
CREATE INDEX IF NOT EXISTS idx_jobs_active
  ON jobs(queue, state, timestamp) WHERE removed_at IS NULL;
-- Covers the disconnected-fallback "latest" view: queue + removed_at IS NULL,
-- ordered by timestamp DESC. Without this, the planner falls back to
-- idx_jobs_queue_state + a TEMP B-TREE sort, which is O(n log n) over the
-- queue's live rows and becomes the bottleneck at multi-million row scale.
CREATE INDEX IF NOT EXISTS idx_jobs_queue_timestamp_live
  ON jobs(queue, timestamp DESC) WHERE removed_at IS NULL;
`;

const QUEUES_SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (
  name TEXT PRIMARY KEY,
  wait_count INTEGER NOT NULL DEFAULT 0,
  active_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  delayed_count INTEGER NOT NULL DEFAULT 0,
  schedulers_count INTEGER NOT NULL DEFAULT 0,
  is_paused INTEGER NOT NULL DEFAULT 0
);
`;

const SCHEDULERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS schedulers (
  queue TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  pattern TEXT,
  every INTEGER,
  next INTEGER,
  iteration_count INTEGER,
  tz TEXT,
  PRIMARY KEY (queue, key)
);
`;

/**
 * Bring a pre-soft-delete jobs table forward. The CREATE TABLE IF NOT EXISTS
 * above is a no-op against an existing table, so older installs would never
 * gain `removed_at` without an explicit ALTER. The partial index in SCHEMA
 * is created idempotently after the column exists.
 */
function migrateRemovedAtColumn(database: Database): void {
  const cols = database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  // Fresh DB: no jobs table yet — SCHEMA below will create it with removed_at.
  if (cols.length === 0) return;
  // Already migrated: column exists.
  if (cols.some((c) => c.name === "removed_at")) return;
  database.exec("ALTER TABLE jobs ADD COLUMN removed_at INTEGER");
}

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  id,
  queue,
  name,
  data_preview,
  content='jobs',
  content_rowid='rowid'
);

-- Keep FTS in sync via triggers
CREATE TRIGGER IF NOT EXISTS jobs_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, id, queue, name, data_preview)
  VALUES (new.rowid, new.id, new.queue, new.name, new.data_preview);
END;

CREATE TRIGGER IF NOT EXISTS jobs_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, id, queue, name, data_preview)
  VALUES ('delete', old.rowid, old.id, old.queue, old.name, old.data_preview);
END;

CREATE TRIGGER IF NOT EXISTS jobs_au AFTER UPDATE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, id, queue, name, data_preview)
  VALUES ('delete', old.rowid, old.id, old.queue, old.name, old.data_preview);
  INSERT INTO jobs_fts(rowid, id, queue, name, data_preview)
  VALUES (new.rowid, new.id, new.queue, new.name, new.data_preview);
END;
`;

const SYNC_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (
  queue TEXT PRIMARY KEY,
  job_count INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Open (and migrate) a SQLite handle for bullmq-dash.
 *
 * Pure factory: callers own the returned `Database`. Used directly by
 * `createContext` in `src/context.ts`; the module-level `db` is a
 * compatibility shim consumed by the still-singleton `getSqliteDb()`.
 */
export function createSqliteDb(config: Config, dbPath?: string): Database {
  const path = dbPath ?? `/tmp/bullmq-dash-${config.redis.host}-${config.redis.port}.db`;
  const handle = new Database(path);
  handle.exec("PRAGMA journal_mode=WAL");
  handle.exec("PRAGMA synchronous=NORMAL");
  // Migration runs BEFORE SCHEMA so the partial index in SCHEMA can reference
  // removed_at on a freshly-upgraded legacy table.
  migrateRemovedAtColumn(handle);
  handle.exec(SCHEMA);
  handle.exec(QUEUES_SCHEMA);
  handle.exec(SCHEDULERS_SCHEMA);
  handle.exec(FTS_SCHEMA);
  handle.exec(SYNC_STATE_SCHEMA);
  db = handle;
  return handle;
}

export function getSqliteDb(): Database {
  if (!db) {
    return createSqliteDb(getConfig());
  }
  return db;
}

export function closeSqliteDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface JobRow {
  id: string;
  queue: string;
  name: string | null;
  state: string;
  timestamp: number | null;
  data_preview: string | null;
  removed_at: number | null;
}

/**
 * Which slice of the cache a read addresses.
 *  - `"live"` (default): only rows where `removed_at IS NULL` — current state.
 *  - `"history"`: only soft-deleted rows. Useful for the historical-view
 *    feature that shows jobs past Redis retention.
 *  - `"all"`: both live and soft-deleted, for debugging and audits.
 */
export type JobView = "live" | "history" | "all";

export interface JobQueryParams {
  queue: string;
  search?: string;
  state?: string | string[];
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  view?: JobView;
}

/** SQL fragment matching the requested view. Returns "" for `"all"`. */
function viewClause(view: JobView, alias: string): string {
  const col = `${alias}removed_at`;
  switch (view) {
    case "live":
      return `${col} IS NULL`;
    case "history":
      return `${col} IS NOT NULL`;
    case "all":
      return "";
  }
}

function appendStateClause(
  conditions: string[],
  values: (string | number)[],
  state: string | string[] | undefined,
  prefix: string,
): void {
  if (Array.isArray(state)) {
    conditions.push(`${prefix}state IN (${state.map(() => "?").join(",")})`);
    values.push(...state);
  } else if (state && state !== "all") {
    conditions.push(`${prefix}state = ?`);
    values.push(state);
  }
}

export interface JobQueryResult {
  jobs: JobRow[];
  total: number;
}

/**
 * Replace the cached queue observation atomically.
 *
 * Treats the supplied list as the authoritative current set: queues missing
 * from `queues` are deleted, and their scheduler rows are dropped in the same
 * transaction so deleted queues don't leak scheduler entries.
 *
 * **Empty input is a wipe.** Passing `[]` deletes every queue and scheduler
 * row. Callers must therefore distinguish "Redis returned no queues" from
 * "the Redis call failed" — the disconnected fallback in polling.ts only
 * triggers on a thrown error, not on an empty successful response. A
 * transient empty observation from upstream will erase the SQLite cache.
 */
export function upsertQueueStats(ctx: Context, queues: QueueStats[]): void {
  const database = ctx.db;
  const stmt = database.prepare(`
    INSERT INTO queues (
      name,
      wait_count,
      active_count,
      completed_count,
      failed_count,
      delayed_count,
      schedulers_count,
      is_paused
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      wait_count = excluded.wait_count,
      active_count = excluded.active_count,
      completed_count = excluded.completed_count,
      failed_count = excluded.failed_count,
      delayed_count = excluded.delayed_count,
      schedulers_count = excluded.schedulers_count,
      is_paused = excluded.is_paused
  `);

  const replaceObservedQueues = database.transaction((items: QueueStats[]) => {
    if (items.length === 0) {
      database.prepare("DELETE FROM queues").run();
      // Schedulers cache is keyed by queue; drop rows for queues that no
      // longer exist so deleted queues don't leak scheduler rows.
      database.prepare("DELETE FROM schedulers").run();
      return;
    }

    for (const queue of items) {
      stmt.run(
        queue.name,
        queue.counts.wait,
        queue.counts.active,
        queue.counts.completed,
        queue.counts.failed,
        queue.counts.delayed,
        queue.counts.schedulers,
        queue.isPaused ? 1 : 0,
      );
    }

    const placeholders = items.map(() => "?").join(",");
    const names = items.map((queue) => queue.name);
    database.prepare(`DELETE FROM queues WHERE name NOT IN (${placeholders})`).run(...names);
    database.prepare(`DELETE FROM schedulers WHERE queue NOT IN (${placeholders})`).run(...names);
  });

  replaceObservedQueues(queues);
}

export interface SchedulerQueryResult {
  schedulers: JobSchedulerSummary[];
  total: number;
}

/**
 * Replace the cached scheduler set for one queue.
 *
 * Mirrors `upsertQueueStats`: upserts the supplied rows, then deletes any
 * row for the same queue whose key is not in the new set. This keeps the
 * cache aligned with the latest Redis observation so a scheduler deleted
 * upstream stops showing up in the disconnected fallback.
 *
 * Pass an empty array to wipe the queue's schedulers.
 */
export function upsertSchedulers(
  ctx: Context,
  queue: string,
  schedulers: JobSchedulerSummary[],
): void {
  const database = ctx.db;
  const stmt = database.prepare(`
    INSERT INTO schedulers (queue, key, name, pattern, every, next, iteration_count, tz)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue, key) DO UPDATE SET
      name = excluded.name,
      pattern = excluded.pattern,
      every = excluded.every,
      next = excluded.next,
      iteration_count = excluded.iteration_count,
      tz = excluded.tz
  `);

  const replaceForQueue = database.transaction((items: JobSchedulerSummary[]) => {
    if (items.length === 0) {
      database.prepare("DELETE FROM schedulers WHERE queue = ?").run(queue);
      return;
    }

    for (const s of items) {
      stmt.run(
        queue,
        s.key,
        s.name,
        s.pattern ?? null,
        s.every ?? null,
        s.next ?? null,
        s.iterationCount ?? null,
        s.tz ?? null,
      );
    }

    const placeholders = items.map(() => "?").join(",");
    database
      .prepare(`DELETE FROM schedulers WHERE queue = ? AND key NOT IN (${placeholders})`)
      .run(queue, ...items.map((s) => s.key));
  });

  replaceForQueue(schedulers);
}

export function querySchedulers(
  ctx: Context,
  queue: string,
  page: number = 1,
  pageSize: number = 25,
): SchedulerQueryResult {
  const database = ctx.db;
  const offset = (page - 1) * pageSize;

  const { total } = database
    .prepare("SELECT COUNT(*) as total FROM schedulers WHERE queue = ?")
    .get(queue) as { total: number };

  const rows = database
    .prepare(`
      SELECT key, name, pattern, every, next, iteration_count, tz
      FROM schedulers
      WHERE queue = ?
      ORDER BY key ASC
      LIMIT ? OFFSET ?
    `)
    .all(queue, pageSize, offset) as Array<{
    key: string;
    name: string;
    pattern: string | null;
    every: number | null;
    next: number | null;
    iteration_count: number | null;
    tz: string | null;
  }>;

  const schedulers: JobSchedulerSummary[] = rows.map((row) => ({
    key: row.key,
    name: row.name,
    pattern: row.pattern ?? undefined,
    every: row.every ?? undefined,
    next: row.next ?? undefined,
    iterationCount: row.iteration_count ?? undefined,
    tz: row.tz ?? undefined,
  }));

  return { schedulers, total };
}

export function queryQueueStats(ctx: Context): QueueStats[] {
  const database = ctx.db;
  const rows = database
    .prepare(`
      SELECT
        name,
        wait_count,
        active_count,
        completed_count,
        failed_count,
        delayed_count,
        schedulers_count,
        is_paused
      FROM queues
      ORDER BY name ASC
    `)
    .all() as Array<{
    name: string;
    wait_count: number;
    active_count: number;
    completed_count: number;
    failed_count: number;
    delayed_count: number;
    schedulers_count: number;
    is_paused: number;
  }>;

  return rows.map((row) => {
    const counts = {
      wait: row.wait_count,
      active: row.active_count,
      completed: row.completed_count,
      failed: row.failed_count,
      delayed: row.delayed_count,
      schedulers: row.schedulers_count,
    };
    return {
      name: row.name,
      counts,
      isPaused: row.is_paused === 1,
      total: counts.wait + counts.active + counts.completed + counts.failed + counts.delayed,
    };
  });
}

export function queryJobs(ctx: Context, params: JobQueryParams): JobQueryResult {
  const database = ctx.db;
  const {
    queue,
    search,
    state,
    sort = "timestamp",
    order = "desc",
    page = 1,
    pageSize = 25,
    view = "live",
  } = params;

  const validSorts = ["id", "name", "state", "timestamp"];
  const sortCol = validSorts.includes(sort) ? sort : "timestamp";
  const sortOrder = order === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;

  if (Array.isArray(state) && state.length === 0) {
    return { jobs: [], total: 0 };
  }

  // When a search term is provided, use FTS5 for sub-ms full-text search.
  // Falls back to LIKE if FTS5 table is somehow unavailable (shouldn't happen).
  if (search) {
    const conditions: string[] = ["j.queue = ?"];
    const values: (string | number)[] = [queue];

    appendStateClause(conditions, values, state, "j.");

    const viewSql = viewClause(view, "j.");
    if (viewSql) conditions.push(viewSql);

    const where = conditions.join(" AND ");
    // FTS5 MATCH uses implicit prefix matching with * for better UX
    const ftsMatch = `${search}*`;

    const countSql = `SELECT COUNT(*) as total FROM jobs j JOIN jobs_fts fts ON j.rowid = fts.rowid WHERE ${where} AND jobs_fts MATCH ?`;
    const total = (database.prepare(countSql).get(...values, ftsMatch) as { total: number }).total;

    const qualifiedSort = `j.${sortCol}`;
    const sql = `SELECT j.* FROM jobs j JOIN jobs_fts fts ON j.rowid = fts.rowid WHERE ${where} AND jobs_fts MATCH ? ORDER BY ${qualifiedSort} ${sortOrder} LIMIT ? OFFSET ?`;
    const jobs = database.prepare(sql).all(...values, ftsMatch, pageSize, offset) as JobRow[];

    return { jobs, total };
  }

  // No search term — plain query without FTS
  const conditions: string[] = ["queue = ?"];
  const values: (string | number)[] = [queue];

  appendStateClause(conditions, values, state, "");

  const viewSql = viewClause(view, "");
  if (viewSql) conditions.push(viewSql);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*) as total FROM jobs ${where}`;
  const total = (database.prepare(countSql).get(...values) as { total: number }).total;

  const sql = `SELECT * FROM jobs ${where} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
  const jobs = database.prepare(sql).all(...values, pageSize, offset) as JobRow[];

  return { jobs, total };
}

/**
 * Serialize `data` to a ≤500-char preview for FTS indexing.
 * Swallows JSON.stringify failures (BigInt, circular refs, throwing getters)
 * so a single bad payload can't poison an entire upsert batch.
 */
function safeDataPreview(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return null;
  }
}

export function upsertJobs(
  ctx: Context,
  queue: string,
  jobs: Array<{ id: string; name: string; state: string; timestamp: number; data?: unknown }>,
): void {
  const database = ctx.db;
  const stmt = database.prepare(`
    INSERT INTO jobs (id, queue, name, state, timestamp, data_preview)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue, id) DO UPDATE SET
      name = excluded.name,
      state = excluded.state,
      timestamp = excluded.timestamp,
      data_preview = excluded.data_preview
  `);

  const upsert = database.transaction((items: typeof jobs) => {
    for (const job of items) {
      const dataPreview = safeDataPreview(job.data);
      stmt.run(job.id, queue, job.name, job.state, job.timestamp, dataPreview);
    }
  });

  upsert(jobs);
}

export function getJobFromDb(
  ctx: Context,
  queue: string,
  jobId: string,
  options: { view?: JobView } = {},
): JobRow | null {
  const database = ctx.db;
  const view = options.view ?? "live";
  const viewSql = viewClause(view, "");
  const sql = viewSql
    ? `SELECT * FROM jobs WHERE queue = ? AND id = ? AND ${viewSql}`
    : "SELECT * FROM jobs WHERE queue = ? AND id = ?";
  return database.prepare(sql).get(queue, jobId) as JobRow | null;
}

export function getQueueJobCount(
  ctx: Context,
  queue: string,
  options: { view?: JobView } = {},
): number {
  const database = ctx.db;
  const view = options.view ?? "live";
  const viewSql = viewClause(view, "");
  const sql = viewSql
    ? `SELECT COUNT(*) as total FROM jobs WHERE queue = ? AND ${viewSql}`
    : "SELECT COUNT(*) as total FROM jobs WHERE queue = ?";
  const result = database.prepare(sql).get(queue) as { total: number };
  return result.total;
}

/**
 * Rebuild the FTS5 index from the jobs table.
 * Useful after bulk operations or if the index gets out of sync.
 */
export function rebuildFtsIndex(ctx: Context): void {
  ctx.db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')");
}

/**
 * Upsert job stubs — only id, queue, and state.
 *
 * Used by incremental sync to cheaply record job existence and state
 * without fetching full job data from Redis. Preserves existing name,
 * timestamp, and data_preview if the job already exists.
 *
 * The ON CONFLICT clause deliberately does NOT touch `removed_at`. Per
 * ADR-0001, soft-deleted IDs are not allowed to reappear in Redis — the
 * reconciler enforces this via the resurrection check. Sync code paths
 * that get here have already passed that check, so leaving `removed_at`
 * alone is correct: if a row is soft-deleted, it stays soft-deleted.
 * (`upsertJobs` follows the same rule for the polling write path.)
 */
export function upsertJobStubs(
  ctx: Context,
  queue: string,
  jobs: Array<{ id: string; state: string }>,
): void {
  const database = ctx.db;
  const stmt = database.prepare(`
    INSERT INTO jobs (id, queue, name, state, timestamp, data_preview)
    VALUES (?, ?, NULL, ?, NULL, NULL)
    ON CONFLICT(queue, id) DO UPDATE SET
      state = excluded.state
  `);

  const upsert = database.transaction((items: typeof jobs) => {
    for (const job of items) {
      stmt.run(job.id, queue, job.state);
    }
  });

  upsert(jobs);
}

export interface SyncState {
  queue: string;
  jobCount: number;
  syncedAt: number;
}

export function getSyncState(ctx: Context, queue: string): SyncState | null {
  const database = ctx.db;
  const row = database
    .prepare("SELECT queue, job_count, synced_at FROM sync_state WHERE queue = ?")
    .get(queue) as { queue: string; job_count: number; synced_at: number } | null;

  if (!row) return null;

  return {
    queue: row.queue,
    jobCount: row.job_count,
    syncedAt: row.synced_at,
  };
}

export function upsertSyncState(
  ctx: Context,
  queue: string,
  input: { jobCount: number; syncedAt: number },
): void {
  const database = ctx.db;
  database
    .prepare(`
    INSERT INTO sync_state (queue, job_count, synced_at)
    VALUES (?, ?, ?)
    ON CONFLICT(queue) DO UPDATE SET
      job_count = excluded.job_count,
      synced_at = excluded.synced_at
  `)
    .run(queue, input.jobCount, input.syncedAt);
}

/**
 * Create the sync_staging temporary table.
 * Called at the start of each sync cycle, dropped at the end.
 *
 * Uses a TEMP table so it never touches disk, is automatically scoped to the
 * current connection (we use a single shared connection — see getSqliteDb),
 * and is cleaned up if the process exits unexpectedly. We also drop any
 * leftover `main.sync_staging` from a previous version that created it on
 * disk, so upgrades don't trip over a stale table.
 */
export function createSyncStaging(ctx: Context): void {
  const database = ctx.db;
  database.exec(`
    DROP TABLE IF EXISTS main.sync_staging;
    DROP TABLE IF EXISTS temp.sync_staging;
    CREATE TEMP TABLE sync_staging (
      id TEXT NOT NULL,
      queue TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (queue, id)
    );
  `);
}

/**
 * Insert a batch of job IDs + states into the staging table.
 * Called repeatedly during paginated getRanges() fetching.
 */
export function insertStagingBatch(
  ctx: Context,
  queue: string,
  jobs: Array<{ id: string; state: string }>,
): void {
  if (jobs.length === 0) return;
  const database = ctx.db;
  const stmt = database.prepare(
    "INSERT OR IGNORE INTO sync_staging (id, queue, state) VALUES (?, ?, ?)",
  );

  const insert = database.transaction((items: typeof jobs) => {
    for (const job of items) {
      stmt.run(job.id, queue, job.state);
    }
  });

  insert(jobs);
}

/**
 * Find job IDs in staging that exist in jobs but as soft-deleted rows.
 *
 * BullMQ job IDs are treated as monotonic (per ADR-0001), so a soft-deleted
 * ID reappearing in Redis is an invariant violation, not a reinstatement —
 * the reconciler will throw on a non-empty result rather than silently
 * undelete the row.
 */
export function findResurrectedIdsByStagingDiff(ctx: Context, queue: string): string[] {
  const database = ctx.db;
  const rows = database
    .prepare(`
    SELECT s.id FROM sync_staging s
    JOIN jobs j ON s.queue = j.queue AND s.id = j.id
    WHERE s.queue = ? AND j.removed_at IS NOT NULL
  `)
    .all(queue) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Find job IDs that exist in staging but not in the jobs table.
 * These are new jobs that need to be inserted. Returns id + state so the
 * caller can build job stubs without a second round-trip to SQLite.
 *
 * Soft-deleted rows still live in `jobs` (with `removed_at IS NOT NULL`),
 * so the LEFT JOIN already excludes them from the "new" set — they show up
 * via findResurrectedIdsByStagingDiff instead.
 */
export function findNewIdsByStagingDiff(
  ctx: Context,
  queue: string,
): Array<{ id: string; state: string }> {
  const database = ctx.db;
  return database
    .prepare(`
    SELECT s.id, s.state FROM sync_staging s
    LEFT JOIN jobs j ON s.queue = j.queue AND s.id = j.id
    WHERE s.queue = ? AND j.id IS NULL
  `)
    .all(queue) as Array<{ id: string; state: string }>;
}

/**
 * Find job IDs that exist in both staging and jobs (as live rows) but have
 * different states. Soft-deleted rows are excluded — those go through the
 * resurrection path (or stay soft-deleted) instead of getting their state
 * silently overwritten.
 */
export function findChangedIdsByStagingDiff(
  ctx: Context,
  queue: string,
): Array<{ id: string; state: string }> {
  const database = ctx.db;
  return database
    .prepare(`
    SELECT s.id, s.state FROM sync_staging s
    JOIN jobs j ON s.queue = j.queue AND s.id = j.id
    WHERE s.queue = ? AND j.removed_at IS NULL AND s.state != j.state
  `)
    .all(queue) as Array<{ id: string; state: string }>;
}

/**
 * Find LIVE job IDs (`removed_at IS NULL`) that exist in the jobs table but
 * NOT in staging. These are soft-delete candidates — the reconciler stamps
 * `removed_at = now` on them. Already soft-deleted rows are skipped so the
 * sync doesn't keep re-stamping them on every cycle.
 *
 * Uses a LEFT JOIN anti-join (rather than `NOT IN (subquery)`) so SQLite can
 * use the (queue, id) primary key on both sides and avoid materializing the
 * staging subquery for every row in `jobs`. This matters at 5M+ scale.
 */
export function findStaleIdsByStagingDiff(ctx: Context, queue: string): string[] {
  const database = ctx.db;
  const rows = database
    .prepare(`
    SELECT j.id FROM jobs j
    LEFT JOIN sync_staging s ON j.queue = s.queue AND j.id = s.id
    WHERE j.queue = ? AND j.removed_at IS NULL AND s.id IS NULL
  `)
    .all(queue) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Mark jobs as soft-deleted by setting `removed_at = now`. Returns the
 * number of rows we asked to update — see deleteJobsByIds for why we don't
 * use `result.changes` here either (FTS5 update triggers inflate it).
 *
 * The reconciler calls this in place of deleteJobsByIds when a job in the
 * cache no longer appears in Redis. Compaction (compactRemovedJobs) does the
 * physical removal once the retention window elapses.
 */
export function softDeleteJobsByIds(
  ctx: Context,
  queue: string,
  ids: string[],
  now: number,
): number {
  if (ids.length === 0) return 0;
  const database = ctx.db;
  const BATCH_SIZE = 900;

  const run = database.transaction(() => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      database
        .prepare(`UPDATE jobs SET removed_at = ? WHERE queue = ? AND id IN (${placeholders})`)
        .run(now, queue, ...batch);
    }
  });
  run();
  return ids.length;
}

/**
 * Physically delete soft-deleted rows older than the retention window.
 * Cutoff is `now − retentionMs`; any row with `removed_at < cutoff` is gone.
 *
 * Counts via SELECT before DELETE because the FTS5 `jobs_ad` trigger writes
 * to the shadow table, which `result.changes` would conflate with the real
 * row deletions (same reason deleteJobsByIds doesn't trust changes()).
 */
export function compactRemovedJobs(ctx: Context, now: number, retentionMs: number): number {
  const database = ctx.db;
  const cutoff = now - retentionMs;
  // Single source of truth so the count and delete can't drift apart.
  const filter = "removed_at IS NOT NULL AND removed_at < ?";
  const run = database.transaction(() => {
    const { n } = database
      .prepare(`SELECT COUNT(*) as n FROM jobs WHERE ${filter}`)
      .get(cutoff) as { n: number };
    if (n > 0) {
      database.prepare(`DELETE FROM jobs WHERE ${filter}`).run(cutoff);
    }
    return n;
  });
  return run();
}

/**
 * Batch-delete jobs by (queue, id). Returns the number of IDs passed in —
 * we don't use `result.changes` because FTS5 triggers inflate the count
 * (shadow table writes from `jobs_ad` are included in the changes tally).
 */
export function deleteJobsByIds(ctx: Context, queue: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const database = ctx.db;
  const BATCH_SIZE = 900;

  const run = database.transaction(() => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      database
        .prepare(`DELETE FROM jobs WHERE queue = ? AND id IN (${placeholders})`)
        .run(queue, ...batch);
    }
  });
  run();
  return ids.length;
}

/**
 * Drop the staging table. Called at the end of each sync cycle.
 */
export function dropSyncStaging(ctx: Context): void {
  ctx.db.exec("DROP TABLE IF EXISTS sync_staging");
}
