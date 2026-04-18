import { Database } from "bun:sqlite";
import { getConfig } from "../config.js";

let db: Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  name TEXT,
  state TEXT NOT NULL,
  timestamp INTEGER,
  data_preview TEXT,
  PRIMARY KEY (queue, id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);
CREATE INDEX IF NOT EXISTS idx_jobs_timestamp ON jobs(timestamp);
`;

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

export function createSqliteDb(dbPath?: string): Database {
  const config = getConfig();
  const path = dbPath ?? `/tmp/bullmq-dash-${config.redis.host}-${config.redis.port}.db`;
  db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(SCHEMA);
  db.exec(FTS_SCHEMA);
  db.exec(SYNC_STATE_SCHEMA);
  return db;
}

export function getSqliteDb(): Database {
  if (!db) {
    return createSqliteDb();
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
}

export interface JobQueryParams {
  queue: string;
  search?: string;
  state?: string;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface JobQueryResult {
  jobs: JobRow[];
  total: number;
}

export function queryJobs(params: JobQueryParams): JobQueryResult {
  const database = getSqliteDb();
  const { queue, search, state, sort = "timestamp", order = "desc", page = 1, pageSize = 25 } = params;

  const validSorts = ["id", "name", "state", "timestamp"];
  const sortCol = validSorts.includes(sort) ? sort : "timestamp";
  const sortOrder = order === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;

  // When a search term is provided, use FTS5 for sub-ms full-text search.
  // Falls back to LIKE if FTS5 table is somehow unavailable (shouldn't happen).
  if (search) {
    const conditions: string[] = ["j.queue = ?"];
    const values: (string | number)[] = [queue];

    if (state && state !== "all") {
      conditions.push("j.state = ?");
      values.push(state);
    }

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

  if (state && state !== "all") {
    conditions.push("state = ?");
    values.push(state);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*) as total FROM jobs ${where}`;
  const total = (database.prepare(countSql).get(...values) as { total: number }).total;

  const sql = `SELECT * FROM jobs ${where} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
  const jobs = database.prepare(sql).all(...values, pageSize, offset) as JobRow[];

  return { jobs, total };
}

export function upsertJobs(
  queue: string,
  jobs: Array<{ id: string; name: string; state: string; timestamp: number; data?: unknown }>,
): void {
  const database = getSqliteDb();
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
      const dataPreview = job.data ? JSON.stringify(job.data).slice(0, 500) : null;
      stmt.run(job.id, queue, job.name, job.state, job.timestamp, dataPreview);
    }
  });

  upsert(jobs);
}

export function deleteStaleJobs(queue: string, activeIds: string[]): number {
  const database = getSqliteDb();

  // Count stale rows first, then delete.
  // We can't rely on result.changes because FTS5 triggers inflate the count
  // (shadow table writes are included in the changes tally).

  if (activeIds.length === 0) {
    const count = (database.prepare("SELECT COUNT(*) as total FROM jobs WHERE queue = ?").get(queue) as { total: number }).total;
    if (count > 0) {
      database.prepare("DELETE FROM jobs WHERE queue = ?").run(queue);
    }
    return count;
  }

  const BATCH_SIZE = 900;
  if (activeIds.length <= BATCH_SIZE) {
    const placeholders = activeIds.map(() => "?").join(",");
    const count = (database.prepare(
      `SELECT COUNT(*) as total FROM jobs WHERE queue = ? AND id NOT IN (${placeholders})`,
    ).get(queue, ...activeIds) as { total: number }).total;
    if (count > 0) {
      database.prepare(
        `DELETE FROM jobs WHERE queue = ? AND id NOT IN (${placeholders})`,
      ).run(queue, ...activeIds);
    }
    return count;
  }

  // For large activeIds sets, find stale IDs explicitly then batch-delete
  const activeIdSet = new Set(activeIds);
  const allJobs = database
    .prepare("SELECT id FROM jobs WHERE queue = ?")
    .all(queue) as Array<{ id: string }>;
  const staleIds = allJobs
    .filter((row) => !activeIdSet.has(row.id))
    .map((row) => row.id);

  if (staleIds.length === 0) return 0;

  const deleteStaleInBatches = database.transaction(() => {
    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = staleIds.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      database.prepare(
        `DELETE FROM jobs WHERE queue = ? AND id IN (${placeholders})`,
      ).run(queue, ...batch);
    }
  });

  deleteStaleInBatches();
  return staleIds.length;
}

export function getJobFromDb(queue: string, jobId: string): JobRow | null {
  const database = getSqliteDb();
  return database.prepare("SELECT * FROM jobs WHERE queue = ? AND id = ?").get(queue, jobId) as JobRow | null;
}

export function getQueueJobCount(queue: string): number {
  const database = getSqliteDb();
  const result = database.prepare("SELECT COUNT(*) as total FROM jobs WHERE queue = ?").get(queue) as { total: number };
  return result.total;
}

/**
 * Rebuild the FTS5 index from the jobs table.
 * Useful after bulk operations or if the index gets out of sync.
 */
export function rebuildFtsIndex(): void {
  const database = getSqliteDb();
  database.exec("INSERT INTO jobs_fts(jobs_fts) VALUES('rebuild')");
}

/**
 * Upsert job stubs — only id, queue, and state.
 *
 * Used by incremental sync to cheaply record job existence and state
 * without fetching full job data from Redis. Preserves existing name,
 * timestamp, and data_preview if the job already exists.
 */
export function upsertJobStubs(
  queue: string,
  jobs: Array<{ id: string; state: string }>,
): void {
  const database = getSqliteDb();
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

export function getSyncState(queue: string): SyncState | null {
  const database = getSqliteDb();
  const row = database.prepare(
    "SELECT queue, job_count, synced_at FROM sync_state WHERE queue = ?",
  ).get(queue) as { queue: string; job_count: number; synced_at: number } | null;

  if (!row) return null;

  return {
    queue: row.queue,
    jobCount: row.job_count,
    syncedAt: row.synced_at,
  };
}

export function upsertSyncState(
  queue: string,
  input: { jobCount: number; syncedAt: number },
): void {
  const database = getSqliteDb();
  database.prepare(`
    INSERT INTO sync_state (queue, job_count, synced_at)
    VALUES (?, ?, ?)
    ON CONFLICT(queue) DO UPDATE SET
      job_count = excluded.job_count,
      synced_at = excluded.synced_at
  `).run(queue, input.jobCount, input.syncedAt);
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
export function createSyncStaging(): void {
  const database = getSqliteDb();
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
  queue: string,
  jobs: Array<{ id: string; state: string }>,
): void {
  if (jobs.length === 0) return;
  const database = getSqliteDb();
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
 * Find job IDs that exist in staging but not in the jobs table.
 * These are new jobs that need to be inserted. Returns id + state so the
 * caller can build job stubs without a second round-trip to SQLite.
 */
export function findNewIdsByStagingDiff(
  queue: string,
): Array<{ id: string; state: string }> {
  const database = getSqliteDb();
  return database.prepare(`
    SELECT s.id, s.state FROM sync_staging s
    LEFT JOIN jobs j ON s.queue = j.queue AND s.id = j.id
    WHERE s.queue = ? AND j.id IS NULL
  `).all(queue) as Array<{ id: string; state: string }>;
}

/**
 * Find job IDs that exist in both staging and jobs table but have different states.
 * Returns the staging (new) state for each changed job.
 */
export function findChangedIdsByStagingDiff(
  queue: string,
): Array<{ id: string; state: string }> {
  const database = getSqliteDb();
  return database.prepare(`
    SELECT s.id, s.state FROM sync_staging s
    JOIN jobs j ON s.queue = j.queue AND s.id = j.id
    WHERE s.queue = ? AND s.state != j.state
  `).all(queue) as Array<{ id: string; state: string }>;
}

/**
 * Delete jobs that exist in the jobs table but NOT in staging.
 * These are stale jobs that were removed from Redis.
 * Returns the number of deleted rows.
 *
 * Uses a LEFT JOIN anti-join (rather than `NOT IN (subquery)`) so SQLite can
 * use the (queue, id) primary key on both sides and avoid materializing the
 * staging subquery for every row in `jobs`. This matters at 5M+ scale.
 *
 * NOTE: We pre-count instead of using `result.changes` because `bun:sqlite`'s
 * `changes` includes trigger-cascaded modifications (FTS shadow table writes
 * from `jobs_ad`), which would over-report the user-visible delete count.
 * The pre-count uses the same index as the DELETE and is cheap relative to
 * the DELETE itself.
 */
export function deleteStaleByStagingDiff(queue: string): number {
  const database = getSqliteDb();
  const count = (database.prepare(`
    SELECT COUNT(*) as total FROM jobs j
    LEFT JOIN sync_staging s ON j.queue = s.queue AND j.id = s.id
    WHERE j.queue = ? AND s.id IS NULL
  `).get(queue) as { total: number }).total;

  if (count > 0) {
    database.prepare(`
      DELETE FROM jobs WHERE rowid IN (
        SELECT j.rowid FROM jobs j
        LEFT JOIN sync_staging s ON j.queue = s.queue AND j.id = s.id
        WHERE j.queue = ? AND s.id IS NULL
      )
    `).run(queue);
  }

  return count;
}

/**
 * Drop the staging table. Called at the end of each sync cycle.
 */
export function dropSyncStaging(): void {
  const database = getSqliteDb();
  database.exec("DROP TABLE IF EXISTS sync_staging");
}
