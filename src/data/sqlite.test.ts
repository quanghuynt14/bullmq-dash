import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { setConfig } from "../config.js";
import {
  closeSqliteDb,
  createSqliteDb,
  deleteStaleJobs,
  getJobFromDb,
  getSqliteDb,
  queryJobs,
  upsertJobs,
  upsertJobStubs,
  getSyncState,
  upsertSyncState,
  createSyncStaging,
  insertStagingBatch,
  deleteStaleByStagingDiff,
  findNewIdsByStagingDiff,
  dropSyncStaging,
  type JobRow,
} from "./sqlite.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-sqlite.db`;

beforeEach(() => {
  setConfig({
    redis: { host: "localhost", port: 6379, db: 0 },
    pollInterval: 3000,
    prefix: "bull",
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
    expect(columnNames).toEqual(["id", "queue", "name", "state", "timestamp", "data_preview"]);

    const pkCols = tableInfo.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toEqual(["id", "queue"]);
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
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ? ORDER BY id").all("email") as JobRow[];
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
    upsertJobs("email", [{ id: "1", name: "job", state: "active", timestamp: 1000, data: longData }]);

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
});

describe("deleteStaleJobs", () => {
  beforeEach(() => {
    upsertJobs("email", [
      { id: "1", name: "job-a", state: "completed", timestamp: 1000 },
      { id: "2", name: "job-b", state: "active", timestamp: 2000 },
      { id: "3", name: "job-c", state: "failed", timestamp: 3000 },
    ]);
  });

  it("removes jobs not in activeIds", () => {
    const removed = deleteStaleJobs("email", ["2", "3"]);
    expect(removed).toBe(1);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ? ORDER BY id").all("email") as JobRow[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("removes all jobs when activeIds is empty", () => {
    const removed = deleteStaleJobs("email", []);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("email") as JobRow[];
    expect(removed).toBe(3);
    expect(rows).toHaveLength(0);
  });

  it("removes nothing when all ids are active", () => {
    const removed = deleteStaleJobs("email", ["1", "2", "3"]);
    expect(removed).toBe(0);
  });

  it("only affects the specified queue", () => {
    upsertJobs("sms", [{ id: "1", name: "sms-job", state: "active", timestamp: 1000 }]);

    deleteStaleJobs("email", ["1"]);

    const db = getSqliteDb();
    const smsRows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("sms") as JobRow[];
    expect(smsRows).toHaveLength(1);
  });

  it("handles more than 999 active IDs by chunking batches", () => {
    const activeIds: string[] = [];
    for (let i = 1; i <= 1500; i++) {
      activeIds.push(String(i));
    }
    activeIds.forEach((id) =>
      upsertJobs("email", [{ id, name: "job", state: "active", timestamp: Number(id) }]),
    );

    const removed = deleteStaleJobs("email", activeIds);
    expect(removed).toBe(0);

    const db = getSqliteDb();
    const countResult = db.prepare("SELECT COUNT(*) as total FROM jobs WHERE queue = ?").get("email") as { total: number };
    expect(countResult.total).toBe(1500);
  });

  it("deletes all jobs for a queue when activeIds is empty", () => {
    upsertJobs("cleanup-test", [
      { id: "1", name: "job-a", state: "completed", timestamp: 1000 },
      { id: "2", name: "job-b", state: "failed", timestamp: 2000 },
    ]);

    const removed = deleteStaleJobs("cleanup-test", []);
    expect(removed).toBe(2);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("cleanup-test") as JobRow[];
    expect(rows).toHaveLength(0);
  });

  it("deletes stale jobs in batches even with more than 999 IDs", () => {
    // Insert 2000 jobs: 1000 stale (1-1000) + 1000 active (1001-2000)
    const allJobs: { id: string; name: string; state: string; timestamp: number }[] = [];
    for (let i = 1; i <= 2000; i++) {
      allJobs.push({
        id: String(i),
        name: i <= 1000 ? "stale-job" : "active-job",
        state: i <= 1000 ? "completed" : "active",
        timestamp: i,
      });
    }
    upsertJobs("email", allJobs);

    // Active IDs are 1001-2000 (the jobs we want to keep)
    const activeIds: string[] = [];
    for (let i = 1001; i <= 2000; i++) {
      activeIds.push(String(i));
    }

    const removed = deleteStaleJobs("email", activeIds);
    expect(removed).toBe(1000);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ? ORDER BY id").all("email") as JobRow[];
    expect(rows).toHaveLength(1000);
    expect(rows[0]!.id).toBe("1001");
    expect(rows[999]!.id).toBe("2000");
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
      { id: "1", name: "send-welcome-email", state: "completed", timestamp: 1000, data: { to: "alice@example.com" } },
      { id: "2", name: "send-newsletter", state: "active", timestamp: 3000, data: { subject: "Weekly digest" } },
      { id: "3", name: "send-receipt", state: "completed", timestamp: 2000, data: { orderId: "ORD-123" } },
      { id: "4", name: "process-payment", state: "failed", timestamp: 4000, data: { amount: 99.99 } },
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
    upsertJobs("email", [{ id: "1", name: "updated-job-name", state: "completed", timestamp: 1000 }]);

    // Old name should not match
    const oldResult = queryJobs({ queue: "email", search: "welcome" });
    expect(oldResult.total).toBe(0);

    // New name should match
    const newResult = queryJobs({ queue: "email", search: "updated" });
    expect(newResult.total).toBe(1);
    expect(newResult.jobs[0]!.id).toBe("1");
  });

  it("FTS5 index stays in sync after deletes", () => {
    deleteStaleJobs("email", ["2", "3"]);

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
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ? ORDER BY id").all("email") as JobRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe("1");
    expect(rows[0]!.state).toBe("active");
    expect(rows[0]!.name).toBeNull();
    expect(rows[0]!.timestamp).toBeNull();
  });

  it("updates state without overwriting non-null name", () => {
    upsertJobs("email", [
      { id: "1", name: "send-email", state: "active", timestamp: 1000 },
    ]);
    upsertJobStubs("email", [{ id: "1", state: "completed" }]);

    const db = getSqliteDb();
    const row = db.prepare("SELECT * FROM jobs WHERE queue = ? AND id = ?").get("email", "1") as JobRow;
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

  it("deletes stale jobs not in staging", () => {
    createSyncStaging();
    insertStagingBatch("email", [
      { id: "1", state: "active" },
      { id: "3", state: "failed" },
    ]);

    const deleted = deleteStaleByStagingDiff("email");
    expect(deleted).toBe(1);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT id FROM jobs WHERE queue = ? ORDER BY id").all("email") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
    dropSyncStaging();
  });

  it("deletes all jobs when staging is empty for queue", () => {
    createSyncStaging();
    // Insert staging for a different queue
    insertStagingBatch("sms", [{ id: "x", state: "active" }]);

    const deleted = deleteStaleByStagingDiff("email");
    expect(deleted).toBe(3);

    const db = getSqliteDb();
    const rows = db.prepare("SELECT * FROM jobs WHERE queue = ?").all("email") as JobRow[];
    expect(rows).toHaveLength(0);
    dropSyncStaging();
  });

  it("updates state for changed jobs via upsertJobStubs", () => {
    createSyncStaging();
    insertStagingBatch("email", [
      { id: "1", state: "completed" },
      { id: "2", state: "completed" },
      { id: "3", state: "active" },
    ]);

    // Find IDs whose state changed
    const db = getSqliteDb();
    const changed = db.prepare(`
      SELECT s.id, s.state FROM sync_staging s
      JOIN jobs j ON s.queue = j.queue AND s.id = j.id
      WHERE s.queue = ? AND s.state != j.state
    `).all("email") as Array<{ id: string; state: string }>;

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

  it("handles large batches in staging", () => {
    createSyncStaging();
    const batch: Array<{ id: string; state: string }> = [];
    for (let i = 0; i < 5000; i++) {
      batch.push({ id: String(i), state: "active" });
    }
    insertStagingBatch("email", batch);

    const db = getSqliteDb();
    const count = db.prepare("SELECT COUNT(*) as total FROM sync_staging WHERE queue = ?").get("email") as { total: number };
    expect(count.total).toBe(5000);
    dropSyncStaging();
  });
});
