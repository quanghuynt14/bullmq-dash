import { Database } from "bun:sqlite";
import type { Config } from "../config.js";
import type { Context } from "../context.js";
import type { QueueStats } from "./queues.js";
import type { JobSchedulerSummary } from "./schedulers.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  name TEXT,
  state TEXT NOT NULL,
  timestamp INTEGER,
  data_preview TEXT,
  data_json TEXT,
  opts_json TEXT,
  attempts_made INTEGER,
  failed_reason TEXT,
  stacktrace_json TEXT,
  returnvalue_json TEXT,
  processed_on INTEGER,
  finished_on INTEGER,
  progress_json TEXT,
  repeat_job_key TEXT,
  delay INTEGER,
  last_observed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queue, id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);
CREATE INDEX IF NOT EXISTS idx_jobs_timestamp ON jobs(timestamp);
CREATE INDEX IF NOT EXISTS idx_jobs_last_observed ON jobs(last_observed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_timestamp
  ON jobs(queue, timestamp DESC);
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
  is_paused INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL DEFAULT 0
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
  last_observed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queue, key)
);
`;

function tableColumns(database: Database, table: string): Set<string> {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function addColumnIfMissing(
  database: Database,
  table: string,
  columns: Set<string>,
  sql: string,
): void {
  const match = sql.match(/ADD COLUMN\s+([a-z_]+)/i);
  const name = match?.[1];
  if (!name || columns.has(name)) return;
  database.exec(`ALTER TABLE ${table} ${sql}`);
  columns.add(name);
}

/**
 * Bring older cache tables forward. The CREATE TABLE IF NOT EXISTS statements
 * are no-ops against existing tables, so added columns need explicit ALTERs.
 */
function migrateCacheColumns(database: Database, now: number): void {
  const jobCols = tableColumns(database, "jobs");
  if (jobCols.size > 0) {
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN data_json TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN opts_json TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN attempts_made INTEGER");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN failed_reason TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN stacktrace_json TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN returnvalue_json TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN processed_on INTEGER");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN finished_on INTEGER");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN progress_json TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN repeat_job_key TEXT");
    addColumnIfMissing(database, "jobs", jobCols, "ADD COLUMN delay INTEGER");
    addColumnIfMissing(
      database,
      "jobs",
      jobCols,
      "ADD COLUMN last_observed_at INTEGER NOT NULL DEFAULT 0",
    );
    database.prepare("UPDATE jobs SET last_observed_at = ? WHERE last_observed_at = 0").run(now);
  }

  const queueCols = tableColumns(database, "queues");
  if (queueCols.size > 0) {
    addColumnIfMissing(
      database,
      "queues",
      queueCols,
      "ADD COLUMN last_observed_at INTEGER NOT NULL DEFAULT 0",
    );
    database.prepare("UPDATE queues SET last_observed_at = ? WHERE last_observed_at = 0").run(now);
  }

  const schedulerCols = tableColumns(database, "schedulers");
  if (schedulerCols.size > 0) {
    addColumnIfMissing(
      database,
      "schedulers",
      schedulerCols,
      "ADD COLUMN last_observed_at INTEGER NOT NULL DEFAULT 0",
    );
    database
      .prepare("UPDATE schedulers SET last_observed_at = ? WHERE last_observed_at = 0")
      .run(now);
  }
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

/**
 * Open (and migrate) a SQLite handle for bullmq-dash. The caller (normally
 * `createContext` in `src/context.ts`) owns the returned handle and is
 * responsible for closing it.
 */
export function createSqliteDb(config: Config, dbPath?: string): Database {
  const path = dbPath ?? `/tmp/bullmq-dash-${config.redis.host}-${config.redis.port}.db`;
  const handle = new Database(path);
  handle.exec("PRAGMA journal_mode=WAL");
  handle.exec("PRAGMA synchronous=NORMAL");
  migrateCacheColumns(handle, Date.now());
  handle.exec(SCHEMA);
  handle.exec(QUEUES_SCHEMA);
  handle.exec(SCHEDULERS_SCHEMA);
  handle.exec(FTS_SCHEMA);
  return handle;
}

export interface JobRow {
  id: string;
  queue: string;
  name: string | null;
  state: string;
  timestamp: number | null;
  data_preview: string | null;
  data_json: string | null;
  opts_json: string | null;
  attempts_made: number | null;
  failed_reason: string | null;
  stacktrace_json: string | null;
  returnvalue_json: string | null;
  processed_on: number | null;
  finished_on: number | null;
  progress_json: string | null;
  repeat_job_key: string | null;
  delay: number | null;
  last_observed_at: number;
}

export interface JobQueryParams {
  queue: string;
  search?: string;
  state?: string | string[];
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
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
 * Legacy queue observation helper. Active callers should use
 * `recordObservedQueues` in queue-store.ts.
 */
export function upsertQueueStats(
  ctx: Context,
  queues: QueueStats[],
  observedAt = Date.now(),
): void {
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
      is_paused,
      last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      wait_count = excluded.wait_count,
      active_count = excluded.active_count,
      completed_count = excluded.completed_count,
      failed_count = excluded.failed_count,
      delayed_count = excluded.delayed_count,
      schedulers_count = excluded.schedulers_count,
      is_paused = excluded.is_paused,
      last_observed_at = excluded.last_observed_at
  `);

  const runUpsert = database.transaction((items: QueueStats[]) => {
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
        observedAt,
      );
    }
  });

  runUpsert(queues);
}

export interface SchedulerQueryResult {
  schedulers: JobSchedulerSummary[];
  total: number;
}

/**
 * Legacy scheduler observation helper. Active callers should use
 * `recordObservedSchedulers` in queue-store.ts.
 */
export function upsertSchedulers(
  ctx: Context,
  queue: string,
  schedulers: JobSchedulerSummary[],
  observedAt = Date.now(),
): void {
  const database = ctx.db;
  const stmt = database.prepare(`
    INSERT INTO schedulers (
      queue,
      key,
      name,
      pattern,
      every,
      next,
      iteration_count,
      tz,
      last_observed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue, key) DO UPDATE SET
      name = excluded.name,
      pattern = excluded.pattern,
      every = excluded.every,
      next = excluded.next,
      iteration_count = excluded.iteration_count,
      tz = excluded.tz,
      last_observed_at = excluded.last_observed_at
  `);

  const runUpsert = database.transaction((items: JobSchedulerSummary[]) => {
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
        observedAt,
      );
    }
  });

  runUpsert(schedulers);
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
      SELECT key, name, pattern, every, next, iteration_count, tz, last_observed_at
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
    last_observed_at: number;
  }>;

  const schedulers: JobSchedulerSummary[] = rows.map((row) => ({
    key: row.key,
    name: row.name,
    pattern: row.pattern ?? undefined,
    every: row.every ?? undefined,
    next: row.next ?? undefined,
    iterationCount: row.iteration_count ?? undefined,
    tz: row.tz ?? undefined,
    lastObservedAt: row.last_observed_at,
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
        is_paused,
        last_observed_at
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
    last_observed_at: number;
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
      lastObservedAt: row.last_observed_at,
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

export interface StoredJobObservation {
  id: string;
  name: string;
  state: string;
  timestamp: number;
  data?: unknown;
  opts?: unknown;
  attemptsMade?: number;
  failedReason?: string | null;
  stacktrace?: string[] | null;
  returnvalue?: unknown;
  processedOn?: number | null;
  finishedOn?: number | null;
  progress?: number | object | null;
  repeatJobKey?: string | null;
  delay?: number | null;
}

function safeJson(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

export function upsertJobs(
  ctx: Context,
  queue: string,
  jobs: StoredJobObservation[],
  observedAt: number = Date.now(),
): void {
  const database = ctx.db;
  const stmt = database.prepare(`
    INSERT INTO jobs (
      id,
      queue,
      name,
      state,
      timestamp,
      data_preview,
      data_json,
      opts_json,
      attempts_made,
      failed_reason,
      stacktrace_json,
      returnvalue_json,
      processed_on,
      finished_on,
      progress_json,
      repeat_job_key,
      delay,
      last_observed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(queue, id) DO UPDATE SET
      name = excluded.name,
      state = excluded.state,
      timestamp = excluded.timestamp,
      data_preview = excluded.data_preview,
      data_json = excluded.data_json,
      opts_json = excluded.opts_json,
      attempts_made = excluded.attempts_made,
      failed_reason = excluded.failed_reason,
      stacktrace_json = excluded.stacktrace_json,
      returnvalue_json = excluded.returnvalue_json,
      processed_on = excluded.processed_on,
      finished_on = excluded.finished_on,
      progress_json = excluded.progress_json,
      repeat_job_key = excluded.repeat_job_key,
      delay = excluded.delay,
      last_observed_at = excluded.last_observed_at
  `);

  const upsert = database.transaction((items: typeof jobs) => {
    for (const job of items) {
      const dataPreview = safeDataPreview(job.data);
      stmt.run(
        job.id,
        queue,
        job.name,
        job.state,
        job.timestamp,
        dataPreview,
        safeJson(job.data),
        safeJson(job.opts),
        job.attemptsMade ?? null,
        job.failedReason ?? null,
        safeJson(job.stacktrace),
        safeJson(job.returnvalue),
        job.processedOn ?? null,
        job.finishedOn ?? null,
        safeJson(job.progress),
        job.repeatJobKey ?? null,
        job.delay ?? null,
        observedAt,
      );
    }
  });

  upsert(jobs);
}

export function getJobFromDb(ctx: Context, queue: string, jobId: string): JobRow | null {
  const database = ctx.db;
  return database
    .prepare("SELECT * FROM jobs WHERE queue = ? AND id = ?")
    .get(queue, jobId) as JobRow | null;
}

/**
 * Rebuild the FTS5 index from the jobs table.
 * Useful after bulk operations or if the index gets out of sync.
 */
export function rebuildFtsIndex(ctx: Context): void {
  ctx.db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')");
}
