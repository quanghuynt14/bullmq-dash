import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { setConfig } from "../config.js";
import {
  closeSqliteDb,
  compactRemovedJobs,
  createSqliteDb,
  findResurrectedIdsByStagingDiff,
  getJobFromDb,
  getSqliteDb,
  queryJobs,
  softDeleteJobsByIds,
  upsertJobs,
  upsertJobStubs,
  getSyncState,
  upsertSyncState,
  createSyncStaging,
  insertStagingBatch,
  findStaleIdsByStagingDiff,
  deleteJobsByIds,
  findNewIdsByStagingDiff,
  findChangedIdsByStagingDiff,
  dropSyncStaging,
  queryQueueStats,
  querySchedulers,
  upsertQueueStats,
  upsertSchedulers,
  type JobRow,
} from "./sqlite.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-sqlite.db`;

beforeEach(() => {
  setConfig({
    redis: { host: "localhost", port: 6379, db: 0 },
    pollInterval: 3000,
    prefix: "bull",
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  });
  createSqliteDb(TEST_DB_PATH);
});

afterEach(() => {
  closeSqliteDb();
  try {
    unlinkSync(TEST_DB_PATH);
  } catch {
    // ignore
  }
  try {
    unlinkSync(`${TEST_DB_PATH}-wal`);
  } catch {
    // ignore
  }
  try {
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

describe("createSqliteDb", () => {
  it("creates the jobs table with correct schema", () => {
    const db = getSqliteDb();
    const tableInfo = db.prepare("PRAGMA table_info(jobs)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const columnNames = tableInfo.map((c) => c.name);
    expect(columnNames).toEqual([
      "id",
      "queue",
      "name",
      "state",
      "timestamp",
      "data_preview",
      "removed_at",
    ]);

    const pkCols = tableInfo.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toEqual(["id", "queue"]);

    const removedAt = tableInfo.find((c) => c.name === "removed_at");
    expect(removedAt).toBeDefined();
    expect(removedAt!.notnull).toBe(0); // nullable
  });

  it("creates the observed queues table", () => {
    const db = getSqliteDb();
    const tableInfo = db.prepare("PRAGMA table_info(queues)").all() as Array<{
      name: string;
    }>;

    const columnNames = tableInfo.map((c) => c.name);
    expect(columnNames).toEqual([
      "name",
      "wait_count",
      "active_count",
      "completed_count",
      "failed_count",
      "delayed_count",
      "schedulers_count",
      "is_paused",
    ]);
  });

  it("creates the observed schedulers table", () => {
    const db = getSqliteDb();
    const tableInfo = db.prepare("PRAGMA table_info(schedulers)").all() as Array<{
      name: string;
      pk: number;
    }>;

    const columnNames = tableInfo.map((c) => c.name);
    expect(columnNames).toEqual([
      "queue",
      "key",
      "name",
      "pattern",
      "every",
      "next",
      "iteration_count",
      "tz",
    ]);

    const pkCols = tableInfo
      .filter((c) => c.pk > 0)
      .toSorted((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(["queue", "key"]);
  });

  it("creates required indexes", () => {
    const db = getSqliteDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_jobs_queue_state");
    expect(indexNames).toContain("idx_jobs_name");
    expect(indexNames).toContain("idx_jobs_timestamp");
    expect(indexNames).toContain("idx_jobs_active");
  });

  it("idx_jobs_active is a partial index over removed_at IS NULL", () => {
    const db = getSqliteDb();
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_jobs_active'")
      .get() as { sql: string } | null;
    expect(row).not.toBeNull();
    // Must filter rows by removed_at IS NULL so "live" reads can use it.
    expect(row!.sql).toMatch(/removed_at\s+IS\s+NULL/i);
  });

  it("migrates an existing jobs table that lacks removed_at", () => {
    // Simulate the pre-soft-delete schema from a prior install.
    closeSqliteDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }

    // Open a raw DB and create the old schema (no removed_at column).
    const raw = new Database(TEST_DB_PATH);
    raw.exec(`
      CREATE TABLE jobs (
        id TEXT NOT NULL,
        queue TEXT NOT NULL,
        name TEXT,
        state TEXT NOT NULL,
        timestamp INTEGER,
        data_preview TEXT,
        PRIMARY KEY (queue, id)
      );
    `);
    raw
      .prepare("INSERT INTO jobs (id, queue, name, state, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("1", "email", "legacy", "active", 1000);
    raw.close();

    // Reopen via createSqliteDb — migration should add removed_at.
    createSqliteDb(TEST_DB_PATH);
    const db = getSqliteDb();

    const tableInfo = db.prepare("PRAGMA table_info(jobs)").all() as Array<{
      name: string;
    }>;
    expect(tableInfo.map((c) => c.name)).toContain("removed_at");

    // Existing row must remain accessible and treated as live (removed_at IS NULL).
    const row = db.prepare("SELECT id, removed_at FROM jobs WHERE id = ?").get("1") as {
      id: string;
      removed_at: number | null;
    };
    expect(row.id).toBe("1");
    expect(row.removed_at).toBeNull();
  });

  it("sets WAL journal mode", () => {
    const db = getSqliteDb();
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });
});

describe("upsertJobs", () => {
  it("inserts new jobs", () => {
    upsertJobs("email", [
      { id: "1", name: "send-welcome", state: "completed", timestamp: 1000 },
      { id: "2", name: "send-newsletter", state: "active", timestamp: 2000 },
    ]);

    const db = getSqliteDb();
    const rows = db
      .prepare("SELECT * FROM jobs WHERE queue = ? ORDER BY id")
      .all("email") as JobRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe("1");
    expect(rows[0]!.name).toBe("send-welcome");
    expect(rows[0]!.state).toBe("completed");
    expect(rows[1]!.id).toBe("2");
  });

  it("updates existing jobs on conflict", () => {
    upsertJobs("email", [{ id: "1", name: "send-welcome", state: "active", timestamp: 1000 }]);
    upsertJobs("email", [{ id: "1", name: "send-welcome", state: "completed", timestamp: 2000 }]);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("email") as JobRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("completed");
    expect(rows[0]!.timestamp).toBe(2000);
  });

  it("stores data_preview truncated to 500 chars", () => {
    const longData = { message: "x".repeat(600) };
    upsertJobs("email", [
      { id: "1", name: "job", state: "active", timestamp: 1000, data: longData },
    ]);

    const db = getSqliteDb();
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get("1") as JobRow;
    expect(row.data_preview).not.toBeNull();
    expect(row.data_preview!.length).toBeLessThanOrEqual(500);
  });

  it("stores null data_preview when no data", () => {
    upsertJobs("email", [{ id: "1", name: "job", state: "active", timestamp: 1000 }]);

    const db = getSqliteDb();
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get("1") as JobRow;
    expect(row.data_preview).toBeNull();
  });

  it("returns null data_preview when JSON.stringify throws (BigInt)", () => {
    // BigInt is not JSON-serializable; safeDataPreview must catch.
    const bad = { amount: 42n };
    upsertJobs("email", [{ id: "1", name: "job", state: "active", timestamp: 1000, data: bad }]);

    const row = getSqliteDb().prepare("SELECT * FROM jobs WHERE id = ?").get("1") as JobRow;
    expect(row.data_preview).toBeNull();
    // The row itself still got upserted — one bad payload must not poison the batch.
    expect(row.id).toBe("1");
  });

  it("returns null data_preview when JSON.stringify throws (circular ref)", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    upsertJobs("email", [
      { id: "1", name: "job", state: "active", timestamp: 1000, data: circular },
    ]);

    const row = getSqliteDb().prepare("SELECT * FROM jobs WHERE id = ?").get("1") as JobRow;
    expect(row.data_preview).toBeNull();
    expect(row.id).toBe("1");
  });

  it("handles jobs across different queues", () => {
    upsertJobs("email", [{ id: "1", name: "send", state: "active", timestamp: 1000 }]);
    upsertJobs("sms", [{ id: "1", name: "send", state: "completed", timestamp: 2000 }]);

    const db = getSqliteDb();
    const emailRows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("email") as JobRow[];
    const smsRows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("sms") as JobRow[];
    expect(emailRows).toHaveLength(1);
    expect(smsRows).toHaveLength(1);
    expect(emailRows[0]!.state).toBe("active");
    expect(smsRows[0]!.state).toBe("completed");
  });
});

describe("queryJobs", () => {
  beforeEach(() => {
    upsertJobs("email", [
      { id: "1", name: "send-welcome", state: "completed", timestamp: 1000 },
      { id: "2", name: "send-newsletter", state: "active", timestamp: 3000 },
      { id: "3", name: "send-receipt", state: "completed", timestamp: 2000 },
      { id: "4", name: "send-promo", state: "failed", timestamp: 4000 },
      { id: "5", name: "send-alert", state: "active", timestamp: 5000 },
    ]);
  });

  it("returns all jobs for a queue", () => {
    const result = queryJobs({ queue: "email" });
    expect(result.jobs).toHaveLength(5);
    expect(result.total).toBe(5);
  });

  it("filters by state", () => {
    const result = queryJobs({ queue: "email", state: "completed" });
    expect(result.jobs).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.jobs.every((j) => j.state === "completed")).toBe(true);
  });

  it("treats state 'all' as no filter", () => {
    const result = queryJobs({ queue: "email", state: "all" });
    expect(result.jobs).toHaveLength(5);
    expect(result.total).toBe(5);
  });

  it("searches by name substring", () => {
    const result = queryJobs({ queue: "email", search: "newsletter" });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.name).toBe("send-newsletter");
  });

  it("search is case-insensitive for LIKE", () => {
    // SQLite LIKE is case-insensitive for ASCII by default
    const result = queryJobs({ queue: "email", search: "Welcome" });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.name).toBe("send-welcome");
  });

  it("combines state and search filters", () => {
    const result = queryJobs({ queue: "email", state: "active", search: "send" });
    expect(result.jobs).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("sorts by timestamp descending by default", () => {
    const result = queryJobs({ queue: "email" });
    expect(result.jobs[0]!.id).toBe("5");
    expect(result.jobs[4]!.id).toBe("1");
  });

  it("sorts by timestamp ascending", () => {
    const result = queryJobs({ queue: "email", sort: "timestamp", order: "asc" });
    expect(result.jobs[0]!.id).toBe("1");
    expect(result.jobs[4]!.id).toBe("5");
  });

  it("sorts by name ascending", () => {
    const result = queryJobs({ queue: "email", sort: "name", order: "asc" });
    expect(result.jobs[0]!.name).toBe("send-alert");
    expect(result.jobs[4]!.name).toBe("send-welcome");
  });

  it("falls back to timestamp for invalid sort column", () => {
    const result = queryJobs({ queue: "email", sort: "invalid_col" });
    expect(result.jobs[0]!.id).toBe("5");
  });

  it("paginates results", () => {
    const page1 = queryJobs({ queue: "email", page: 1, pageSize: 2 });
    expect(page1.jobs).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.jobs[0]!.id).toBe("5");

    const page2 = queryJobs({ queue: "email", page: 2, pageSize: 2 });
    expect(page2.jobs).toHaveLength(2);
    expect(page2.total).toBe(5);
    expect(page2.jobs[0]!.id).toBe("2");

    const page3 = queryJobs({ queue: "email", page: 3, pageSize: 2 });
    expect(page3.jobs).toHaveLength(1);
    expect(page3.total).toBe(5);
    expect(page3.jobs[0]!.id).toBe("1");
  });

  it("returns empty for nonexistent queue", () => {
    const result = queryJobs({ queue: "nonexistent" });
    expect(result.jobs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns empty when search matches nothing", () => {
    const result = queryJobs({ queue: "email", search: "zzz_not_found" });
    expect(result.jobs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns empty when state filter matches nothing", () => {
    const result = queryJobs({ queue: "email", state: "delayed" });
    expect(result.jobs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns empty for an empty state filter array", () => {
    const result = queryJobs({ queue: "email", state: [] });
    expect(result.jobs).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("queryJobs / getJobFromDb view filter", () => {
  beforeEach(() => {
    upsertJobs("email", [
      { id: "live-1", name: "send-active", state: "active", timestamp: 1000 },
      { id: "live-2", name: "send-completed", state: "completed", timestamp: 2000 },
      { id: "gone", name: "send-trashed", state: "completed", timestamp: 500 },
    ]);
    softDeleteJobsByIds("email", ["gone"], 1_700_000_000_000);
  });

  it("queryJobs default view excludes soft-deleted rows", () => {
    const result = queryJobs({ queue: "email" });
    expect(result.total).toBe(2);
    expect(result.jobs.map((j) => j.id).toSorted()).toEqual(["live-1", "live-2"]);
  });

  it("queryJobs view='history' returns only soft-deleted rows", () => {
    const result = queryJobs({ queue: "email", view: "history" });
    expect(result.total).toBe(1);
    expect(result.jobs[0]!.id).toBe("gone");
    expect(result.jobs[0]!.removed_at).toBe(1_700_000_000_000);
  });

  it("queryJobs view='all' returns both live and soft-deleted rows", () => {
    const result = queryJobs({ queue: "email", view: "all" });
    expect(result.total).toBe(3);
  });

  it("FTS search default view excludes soft-deleted rows", () => {
    const result = queryJobs({ queue: "email", search: "send" });
    expect(result.total).toBe(2);
    expect(result.jobs.every((j) => !j.id.startsWith("gone"))).toBe(true);
  });

  it("FTS search view='all' includes soft-deleted rows", () => {
    const result = queryJobs({ queue: "email", search: "send", view: "all" });
    expect(result.total).toBe(3);
  });

  it("FTS search view='history' returns only soft-deleted matches", () => {
    const result = queryJobs({ queue: "email", search: "trashed", view: "history" });
    expect(result.total).toBe(1);
    expect(result.jobs[0]!.id).toBe("gone");
  });

  it("getJobFromDb default view returns null for soft-deleted job", () => {
    expect(getJobFromDb("email", "gone")).toBeNull();
  });

  it("getJobFromDb view='all' returns soft-deleted job", () => {
    const row = getJobFromDb("email", "gone", { view: "all" });
    expect(row).not.toBeNull();
    expect(row!.removed_at).toBe(1_700_000_000_000);
  });
});

describe("getJobFromDb", () => {
  it("returns a job row for existing job", () => {
    upsertJobs("email", [{ id: "42", name: "my-job", state: "completed", timestamp: 5000 }]);

    const row = getJobFromDb("email", "42");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("42");
    expect(row!.name).toBe("my-job");
    expect(row!.state).toBe("completed");
  });

  it("returns null for nonexistent job", () => {
    const row = getJobFromDb("email", "999");
    expect(row).toBeNull();
  });

  it("returns null when queue does not match", () => {
    upsertJobs("email", [{ id: "42", name: "my-job", state: "completed", timestamp: 5000 }]);

    const row = getJobFromDb("sms", "42");
    expect(row).toBeNull();
  });
});

describe("closeSqliteDb", () => {
  it("allows re-creation after close", () => {
    upsertJobs("email", [{ id: "1", name: "job", state: "active", timestamp: 1000 }]);
    closeSqliteDb();

    createSqliteDb(TEST_DB_PATH);
    const row = getJobFromDb("email", "1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("1");
  });
});

describe("FTS5 full-text search", () => {
  beforeEach(() => {
    upsertJobs("email", [
      {
        id: "1",
        name: "send-welcome-email",
        state: "completed",
        timestamp: 1000,
        data: { to: "alice@example.com" },
      },
      {
        id: "2",
        name: "send-newsletter",
        state: "active",
        timestamp: 3000,
        data: { subject: "Weekly digest" },
      },
      {
        id: "3",
        name: "send-receipt",
        state: "completed",
        timestamp: 2000,
        data: { orderId: "ORD-123" },
      },
      {
        id: "4",
        name: "process-payment",
        state: "failed",
        timestamp: 4000,
        data: { amount: 99.99 },
      },
      { id: "5", name: "send-alert-notification", state: "active", timestamp: 5000 },
    ]);
  });

  it("FTS5 virtual table is created", () => {
    const db = getSqliteDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_fts'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("search by name uses FTS5 and returns matches", () => {
    const result = queryJobs({ queue: "email", search: "send" });
    expect(result.total).toBe(4);
    expect(result.jobs.every((j) => j.name?.includes("send"))).toBe(true);
  });

  it("search by name prefix works with FTS5", () => {
    const result = queryJobs({ queue: "email", search: "news" });
    expect(result.total).toBe(1);
    expect(result.jobs[0]!.name).toBe("send-newsletter");
  });

  it("search finds matches in data_preview", () => {
    const result = queryJobs({ queue: "email", search: "alice" });
    expect(result.total).toBe(1);
    expect(result.jobs[0]!.id).toBe("1");
  });

  it("search combined with state filter", () => {
    const result = queryJobs({ queue: "email", search: "send", state: "completed" });
    expect(result.total).toBe(2);
    expect(result.jobs.every((j) => j.state === "completed")).toBe(true);
  });

  it("FTS5 respects pagination", () => {
    const page1 = queryJobs({ queue: "email", search: "send", page: 1, pageSize: 2 });
    expect(page1.jobs).toHaveLength(2);
    expect(page1.total).toBe(4);

    const page2 = queryJobs({ queue: "email", search: "send", page: 2, pageSize: 2 });
    expect(page2.jobs).toHaveLength(2);
    expect(page2.total).toBe(4);
  });

  it("FTS5 search returns empty for no match", () => {
    const result = queryJobs({ queue: "email", search: "zzz_not_found" });
    expect(result.total).toBe(0);
    expect(result.jobs).toHaveLength(0);
  });

  it("FTS5 index stays in sync after updates", () => {
    // Update job name
    upsertJobs("email", [
      { id: "1", name: "updated-job-name", state: "completed", timestamp: 1000 },
    ]);

    // Old name should not match
    const oldResult = queryJobs({ queue: "email", search: "welcome" });
    expect(oldResult.total).toBe(0);

    // New name should match
    const newResult = queryJobs({ queue: "email", search: "updated" });
    expect(newResult.total).toBe(1);
    expect(newResult.jobs[0]!.id).toBe("1");
  });

  it("FTS5 index stays in sync after deletes", () => {
    deleteJobsByIds("email", ["1", "4", "5"]);

    // Deleted jobs should not appear in search
    const result = queryJobs({ queue: "email", search: "send" });
    // Only jobs 2 and 3 remain, both have "send" in name
    expect(result.total).toBe(2);
  });

  it("sort order works with FTS5 search", () => {
    const result = queryJobs({ queue: "email", search: "send", sort: "timestamp", order: "asc" });
    expect(result.jobs[0]!.id).toBe("1");
    expect(result.jobs[result.jobs.length - 1]!.id).toBe("5");
  });
});

describe("upsertJobStubs", () => {
  it("inserts job stubs with null name and timestamp", () => {
    upsertJobStubs("email", [
      { id: "1", state: "active" },
      { id: "2", state: "completed" },
    ]);

    const db = getSqliteDb();
    const rows = db
      .prepare("SELECT * FROM jobs WHERE queue = ? ORDER BY id")
      .all("email") as JobRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe("1");
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.name).toBeNull();
    expect(rows[0]!.timestamp).toBeNull();
  });

  it("updates state without overwriting non-null name", () => {
    upsertJobs("email", [{ id: "1", name: "send-email", state: "active", timestamp: 1000 }]);
    upsertJobStubs("email", [{ id: "1", state: "completed" }]);

    const db = getSqliteDb();
    const row = db
      .prepare("SELECT * FROM jobs WHERE queue = ? AND id = ?")
      .get("email", "1") as JobRow;
    expect(row.state).toBe("completed");
    expect(row.name).toBe("send-email");
    expect(row.timestamp).toBe(1000);
  });

  it("does not overwrite name with null on stub upsert", () => {
    upsertJobs("email", [
      { id: "1", name: "my-job", state: "active", timestamp: 5000, data: { key: "val" } },
    ]);
    upsertJobStubs("email", [{ id: "1", state: "failed" }]);

    const row = getJobFromDb("email", "1");
    expect(row!.state).toBe("failed");
    expect(row!.name).toBe("my-job");
    expect(row!.timestamp).toBe(5000);
    expect(row!.data_preview).not.toBeNull();
  });
});

describe("queue observations", () => {
  it("returns queue stats from observed queue rows", () => {
    upsertQueueStats([
      {
        name: "empty",
        counts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 2 },
        isPaused: true,
        total: 0,
      },
      {
        name: "email",
        counts: { wait: 3, active: 1, completed: 5, failed: 1, delayed: 2, schedulers: 0 },
        isPaused: false,
        total: 12,
      },
    ]);

    expect(queryQueueStats()).toEqual([
      {
        name: "email",
        counts: { wait: 3, active: 1, completed: 5, failed: 1, delayed: 2, schedulers: 0 },
        isPaused: false,
        total: 12,
      },
      {
        name: "empty",
        counts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 2 },
        isPaused: true,
        total: 0,
      },
    ]);
  });

  it("overwrites the existing row when upserted again", () => {
    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 3, active: 1, completed: 5, failed: 1, delayed: 2, schedulers: 0 },
        isPaused: false,
        total: 12,
      },
    ]);
    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 0, active: 0, completed: 7, failed: 0, delayed: 0, schedulers: 4 },
        isPaused: true,
        total: 7,
      },
    ]);

    expect(queryQueueStats()).toEqual([
      {
        name: "email",
        counts: { wait: 0, active: 0, completed: 7, failed: 0, delayed: 0, schedulers: 4 },
        isPaused: true,
        total: 7,
      },
    ]);
  });

  it("removes queues no longer present in the latest observation", () => {
    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 3, active: 1, completed: 5, failed: 1, delayed: 2, schedulers: 0 },
        isPaused: false,
        total: 12,
      },
      {
        name: "video",
        counts: { wait: 1, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 0 },
        isPaused: false,
        total: 1,
      },
    ]);

    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 0, active: 0, completed: 7, failed: 0, delayed: 0, schedulers: 4 },
        isPaused: true,
        total: 7,
      },
    ]);

    expect(queryQueueStats()).toEqual([
      {
        name: "email",
        counts: { wait: 0, active: 0, completed: 7, failed: 0, delayed: 0, schedulers: 4 },
        isPaused: true,
        total: 7,
      },
    ]);
  });

  it("clears queue stats when the latest observation is empty", () => {
    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 3, active: 1, completed: 5, failed: 1, delayed: 2, schedulers: 0 },
        isPaused: false,
        total: 12,
      },
    ]);

    upsertQueueStats([]);

    expect(queryQueueStats()).toEqual([]);
  });

  it("drops scheduler rows for queues removed by the latest observation", () => {
    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 1, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 1 },
        isPaused: false,
        total: 1,
      },
      {
        name: "video",
        counts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 1 },
        isPaused: false,
        total: 0,
      },
    ]);
    upsertSchedulers("email", [{ key: "daily", name: "daily" }]);
    upsertSchedulers("video", [{ key: "weekly", name: "weekly" }]);

    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 1, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 1 },
        isPaused: false,
        total: 1,
      },
    ]);

    expect(querySchedulers("email", 1, 25).total).toBe(1);
    expect(querySchedulers("video", 1, 25).total).toBe(0);
  });

  it("drops every scheduler row when the latest observation is empty", () => {
    upsertQueueStats([
      {
        name: "email",
        counts: { wait: 1, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 1 },
        isPaused: false,
        total: 1,
      },
    ]);
    upsertSchedulers("email", [{ key: "daily", name: "daily" }]);

    upsertQueueStats([]);

    expect(querySchedulers("email", 1, 25).total).toBe(0);
  });
});

describe("scheduler observations", () => {
  it("returns paginated schedulers for one queue", () => {
    upsertSchedulers("email", [
      { key: "daily", name: "daily", pattern: "0 0 * * *" },
      { key: "hourly", name: "hourly", every: 3_600_000 },
    ]);
    upsertSchedulers("video", [{ key: "weekly", name: "weekly", every: 604_800_000 }]);

    const result = querySchedulers("email", 1, 25);
    expect(result.total).toBe(2);
    expect(result.schedulers.map((s) => s.key)).toEqual(["daily", "hourly"]);
    // Unset numeric/string fields become undefined, not null, on the way out.
    expect(result.schedulers[0]).toEqual({
      key: "daily",
      name: "daily",
      pattern: "0 0 * * *",
      every: undefined,
      next: undefined,
      iterationCount: undefined,
      tz: undefined,
    });
  });

  it("replaces existing schedulers for the same queue", () => {
    upsertSchedulers("email", [
      { key: "old-a", name: "old-a" },
      { key: "old-b", name: "old-b" },
    ]);
    upsertSchedulers("email", [{ key: "new", name: "new", pattern: "*/5 * * * *" }]);

    expect(querySchedulers("email", 1, 25).schedulers.map((s) => s.key)).toEqual(["new"]);
  });

  it("does not touch schedulers in other queues", () => {
    upsertSchedulers("email", [{ key: "e1", name: "e1" }]);
    upsertSchedulers("video", [{ key: "v1", name: "v1" }]);
    upsertSchedulers("email", []);

    expect(querySchedulers("email", 1, 25).total).toBe(0);
    expect(querySchedulers("video", 1, 25).schedulers.map((s) => s.key)).toEqual(["v1"]);
  });

  it("paginates with offset and limit", () => {
    upsertSchedulers(
      "email",
      Array.from({ length: 30 }, (_, i) => ({
        key: `s-${String(i).padStart(2, "0")}`,
        name: `s-${i}`,
      })),
    );

    const page1 = querySchedulers("email", 1, 25);
    expect(page1.total).toBe(30);
    expect(page1.schedulers).toHaveLength(25);
    expect(page1.schedulers[0].key).toBe("s-00");

    const page2 = querySchedulers("email", 2, 25);
    expect(page2.schedulers).toHaveLength(5);
    expect(page2.schedulers[0].key).toBe("s-25");
  });
});

describe("sync_state", () => {
  it("getSyncState returns null for unknown queue", () => {
    const state = getSyncState("nonexistent");
    expect(state).toBeNull();
  });

  it("upsertSyncState creates new entry", () => {
    upsertSyncState("email", { jobCount: 100, syncedAt: 1000 });

    const state = getSyncState("email");
    expect(state).not.toBeNull();
    expect(state!.queue).toBe("email");
    expect(state!.jobCount).toBe(100);
    expect(state!.syncedAt).toBe(1000);
  });

  it("upsertSyncState updates existing entry", () => {
    upsertSyncState("email", { jobCount: 100, syncedAt: 1000 });
    upsertSyncState("email", { jobCount: 200, syncedAt: 2000 });

    const state = getSyncState("email");
    expect(state!.jobCount).toBe(200);
    expect(state!.syncedAt).toBe(2000);
  });

  it("handles queues independently", () => {
    upsertSyncState("email", { jobCount: 10, syncedAt: 1000 });
    upsertSyncState("sms", { jobCount: 20, syncedAt: 2000 });

    expect(getSyncState("email")!.jobCount).toBe(10);
    expect(getSyncState("sms")!.jobCount).toBe(20);
  });
});

describe("softDeleteJobsByIds", () => {
  beforeEach(() => {
    upsertJobs("email", [
      { id: "1", name: "a", state: "active", timestamp: 1000 },
      { id: "2", name: "b", state: "completed", timestamp: 2000 },
      { id: "3", name: "c", state: "failed", timestamp: 3000 },
    ]);
  });

  it("sets removed_at = now for given ids without dropping the row", () => {
    const now = 1_700_000_000_000;
    const updated = softDeleteJobsByIds("email", ["2"], now);
    expect(updated).toBe(1);

    // Soft-deleted rows hide from the default view; ask for "all" to verify.
    const row = getJobFromDb("email", "2", { view: "all" });
    expect(row).not.toBeNull();
    expect(row!.removed_at).toBe(now);
    // Other rows are unaffected.
    expect(getJobFromDb("email", "1")!.removed_at).toBeNull();
    expect(getJobFromDb("email", "3")!.removed_at).toBeNull();
  });

  it("returns 0 and is a no-op for an empty id list", () => {
    const updated = softDeleteJobsByIds("email", [], Date.now());
    expect(updated).toBe(0);
  });

  it("does not soft-delete jobs in a different queue", () => {
    upsertJobs("sms", [{ id: "1", name: "x", state: "active", timestamp: 1 }]);
    softDeleteJobsByIds("email", ["1"], 1_700_000_000_000);
    expect(getJobFromDb("sms", "1")!.removed_at).toBeNull();
  });

  it("re-soft-deleting an already soft-deleted row updates the timestamp", () => {
    softDeleteJobsByIds("email", ["1"], 100);
    softDeleteJobsByIds("email", ["1"], 200);
    const row = getJobFromDb("email", "1", { view: "all" });
    expect(row!.removed_at).toBe(200);
  });
});

describe("compactRemovedJobs", () => {
  it("physically deletes rows where removed_at < now − retention", () => {
    upsertJobs("email", [
      { id: "old", name: "a", state: "completed", timestamp: 1 },
      { id: "recent", name: "b", state: "completed", timestamp: 2 },
      { id: "live", name: "c", state: "active", timestamp: 3 },
    ]);
    softDeleteJobsByIds("email", ["old"], 1_000);
    softDeleteJobsByIds("email", ["recent"], 9_000);

    const removed = compactRemovedJobs(10_000, 5_000); // cutoff = 5_000
    expect(removed).toBe(1);

    expect(getJobFromDb("email", "old", { view: "all" })).toBeNull(); // physically gone
    expect(getJobFromDb("email", "recent", { view: "all" })).not.toBeNull(); // soft-deleted but inside window
    expect(getJobFromDb("email", "live")).not.toBeNull(); // never soft-deleted
  });

  it("ignores live rows (removed_at IS NULL) regardless of age", () => {
    upsertJobs("email", [{ id: "1", name: "a", state: "active", timestamp: 1 }]);
    const removed = compactRemovedJobs(Date.now(), 1);
    expect(removed).toBe(0);
    expect(getJobFromDb("email", "1")).not.toBeNull();
  });

  it("compacts across queues in one pass", () => {
    upsertJobs("email", [{ id: "1", name: "a", state: "active", timestamp: 1 }]);
    upsertJobs("sms", [{ id: "1", name: "b", state: "active", timestamp: 1 }]);
    softDeleteJobsByIds("email", ["1"], 100);
    softDeleteJobsByIds("sms", ["1"], 100);

    const removed = compactRemovedJobs(10_000, 1_000); // cutoff = 9_000
    expect(removed).toBe(2);
    expect(getJobFromDb("email", "1", { view: "all" })).toBeNull();
    expect(getJobFromDb("sms", "1", { view: "all" })).toBeNull();
  });

  it("removes compacted rows from the FTS index", () => {
    upsertJobs("email", [{ id: "1", name: "send-receipt", state: "completed", timestamp: 1 }]);
    softDeleteJobsByIds("email", ["1"], 100);
    compactRemovedJobs(10_000, 1_000);

    // Search via raw FTS to bypass any view filter — the row should be gone
    // from the index entirely after physical delete fires the jobs_ad trigger.
    const db = getSqliteDb();
    const hits = db
      .prepare("SELECT COUNT(*) as n FROM jobs_fts WHERE jobs_fts MATCH 'receipt*'")
      .get() as { n: number };
    expect(hits.n).toBe(0);
  });
});

describe("staging table diff", () => {
  beforeEach(() => {
    upsertJobs("email", [
      { id: "1", name: "job-a", state: "active", timestamp: 1000 },
      { id: "2", name: "job-b", state: "completed", timestamp: 2000 },
      { id: "3", name: "job-c", state: "failed", timestamp: 3000 },
    ]);
  });

  it("finds new IDs not in jobs table", () => {
    createSyncStaging();
    insertStagingBatch("email", [
      { id: "1", state: "active" },
      { id: "2", state: "completed" },
      { id: "3", state: "failed" },
      { id: "4", state: "active" },
      { id: "5", state: "delayed" },
    ]);

    const newIds = findNewIdsByStagingDiff("email");
    expect(newIds.map((r) => r.id).toSorted()).toEqual(["4", "5"]);
    expect(newIds.find((r) => r.id === "4")?.state).toBe("active");
    expect(newIds.find((r) => r.id === "5")?.state).toBe("delayed");
    dropSyncStaging();
  });

  it("finds and deletes stale jobs not in staging", () => {
    createSyncStaging();
    insertStagingBatch("email", [
      { id: "1", state: "active" },
      { id: "3", state: "failed" },
    ]);

    const staleIds = findStaleIdsByStagingDiff("email");
    expect(staleIds.toSorted()).toEqual(["2"]);

    const deleted = deleteJobsByIds("email", staleIds);
    expect(deleted).toBe(1);

    const db = getSqliteDb();
    const rows = db
      .prepare("SELECT id FROM jobs WHERE queue = ? ORDER BY id")
      .all("email") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
    dropSyncStaging();
  });

  it("finds all jobs stale when staging is empty for queue", () => {
    createSyncStaging();
    // Insert staging for a different queue
    insertStagingBatch("sms", [{ id: "x", state: "active" }]);

    const staleIds = findStaleIdsByStagingDiff("email");
    expect(staleIds).toHaveLength(3);

    const deleted = deleteJobsByIds("email", staleIds);
    expect(deleted).toBe(3);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("email") as JobRow[];
    expect(rows).toHaveLength(0);
    dropSyncStaging();
  });

  it("findStaleIdsByStagingDiff filter path enables sync to skip recently-polled rows", () => {
    createSyncStaging();
    // Staging only has id 1 — ids 2 and 3 would normally be stale
    insertStagingBatch("email", [{ id: "1", state: "active" }]);

    // Simulate "polling just wrote id=3": filter it out of the stale list
    const recentlyPolled = new Set(["3"]);
    const toDelete = findStaleIdsByStagingDiff("email").filter((id) => !recentlyPolled.has(id));
    expect(toDelete.toSorted()).toEqual(["2"]);

    deleteJobsByIds("email", toDelete);

    const db = getSqliteDb();
    const rows = db
      .prepare("SELECT id FROM jobs WHERE queue = ? ORDER BY id")
      .all("email") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
    dropSyncStaging();
  });

  it("updates state for changed jobs via upsertJobStubs", () => {
    createSyncStaging();
    insertStagingBatch("email", [
      { id: "1", state: "completed" },
      { id: "2", state: "completed" },
      { id: "3", state: "active" },
    ]);

    const changed = findChangedIdsByStagingDiff("email");

    expect(changed).toHaveLength(2);
    expect(changed.map((c) => c.id).toSorted()).toEqual(["1", "3"]);

    // Apply state updates via stubs
    upsertJobStubs("email", changed);

    const row1 = getJobFromDb("email", "1");
    expect(row1!.state).toBe("completed");
    expect(row1!.name).toBe("job-a"); // preserved

    const row3 = getJobFromDb("email", "3");
    expect(row3!.state).toBe("active");
    expect(row3!.name).toBe("job-c"); // preserved

    dropSyncStaging();
  });

  it("findResurrectedIdsByStagingDiff returns staging ids that are soft-deleted in jobs", () => {
    softDeleteJobsByIds("email", ["2"], 1_000); // job-b is now soft-deleted

    createSyncStaging();
    insertStagingBatch("email", [
      { id: "1", state: "active" }, // live in jobs — not resurrected
      { id: "2", state: "completed" }, // soft-deleted in jobs — RESURRECTED
      { id: "4", state: "delayed" }, // not in jobs — new, not resurrected
    ]);

    const resurrected = findResurrectedIdsByStagingDiff("email");
    expect(resurrected.toSorted()).toEqual(["2"]);
    dropSyncStaging();
  });

  it("findNewIdsByStagingDiff excludes resurrected (soft-deleted) rows", () => {
    softDeleteJobsByIds("email", ["2"], 1_000);

    createSyncStaging();
    insertStagingBatch("email", [
      { id: "2", state: "completed" }, // resurrection — must NOT be reported as new
      { id: "9", state: "active" }, // genuinely new
    ]);

    const newIds = findNewIdsByStagingDiff("email")
      .map((r) => r.id)
      .toSorted();
    expect(newIds).toEqual(["9"]);
    dropSyncStaging();
  });

  it("findChangedIdsByStagingDiff ignores soft-deleted rows", () => {
    softDeleteJobsByIds("email", ["2"], 1_000); // jobs row state=completed, soft-deleted

    createSyncStaging();
    // staging.state="active" differs from jobs.state="completed", but the row
    // is soft-deleted — resurrection takes precedence over the changed path.
    insertStagingBatch("email", [{ id: "2", state: "active" }]);

    const changed = findChangedIdsByStagingDiff("email");
    expect(changed).toEqual([]);
    dropSyncStaging();
  });

  it("findStaleIdsByStagingDiff ignores rows already soft-deleted", () => {
    softDeleteJobsByIds("email", ["2"], 1_000);

    createSyncStaging();
    // Staging is empty for queue email — under the old semantics, all three
    // rows would be stale; with soft-delete, the already-removed row is
    // skipped so we don't churn it on every sync.
    insertStagingBatch("sms", [{ id: "x", state: "active" }]);

    const staleIds = findStaleIdsByStagingDiff("email").toSorted();
    expect(staleIds).toEqual(["1", "3"]);
    dropSyncStaging();
  });

  it("handles large batches in staging", () => {
    createSyncStaging();
    const batch: Array<{ id: string; state: string }> = [];
    for (let i = 0; i < 5000; i++) {
      batch.push({ id: String(i), state: "active" });
    }
    insertStagingBatch("email", batch);

    const db = getSqliteDb();
    const count = db
      .prepare("SELECT COUNT(*) as total FROM sync_staging WHERE queue = ?")
      .get("email") as { total: number };
    expect(count.total).toBe(5000);
    dropSyncStaging();
  });
});
