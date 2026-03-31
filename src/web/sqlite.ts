import { Database } from "bun:sqlite";
import { getConfig } from "../config.js";

let db: Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data_preview TEXT,
  PRIMARY KEY (queue, id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);
CREATE INDEX IF NOT EXISTS idx_jobs_timestamp ON jobs(timestamp);
`;

export function createSqliteDb(dbPath?: string): Database {
  const config = getConfig();
  const path = dbPath ?? `/tmp/bullmq-dash-${config.redis.host}-${config.redis.port}.db`;
  db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(SCHEMA);
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
  name: string;
  state: string;
  timestamp: number;
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

  const conditions: string[] = ["queue = ?"];
  const values: (string | number)[] = [queue];

  if (state && state !== "all") {
    conditions.push("state = ?");
    values.push(state);
  }

  if (search) {
    conditions.push("name LIKE ?");
    values.push(`%${search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * pageSize;

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
  if (activeIds.length === 0) return 0;

  const placeholders = activeIds.map(() => "?").join(",");
  const result = database.prepare(
    `DELETE FROM jobs WHERE queue = ? AND id NOT IN (${placeholders})`,
  ).run(queue, ...activeIds);
  return result.changes;
}

export function getJobFromDb(queue: string, jobId: string): JobRow | null {
  const database = getSqliteDb();
  return database.prepare("SELECT * FROM jobs WHERE queue = ? AND id = ?").get(queue, jobId) as JobRow | null;
}

export async function syncQueue(queueName: string): Promise<void> {
  const { getAllJobs } = await import("../data/jobs.js");
  const jobs = await getAllJobs(queueName, undefined, 10000);
  const rows = jobs.jobs.map((j) => ({
    id: j.id,
    name: j.name,
    state: j.state,
    timestamp: j.timestamp,
    data: undefined,
  }));
  upsertJobs(queueName, rows);
}

export async function fullSync(): Promise<void> {
  const { discoverQueueNames } = await import("../data/queues.js");
  const queues = await discoverQueueNames();
  for (const queueName of queues) {
    await syncQueue(queueName);
  }
}
