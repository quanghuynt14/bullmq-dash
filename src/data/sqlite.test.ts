import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { createContext, type Context } from "../context.js";
import type { Config } from "../config.js";
import { createSqliteDb } from "./sqlite.js";
import {
  expireStaleRecords,
  getCacheState,
  getJob,
  listJobs,
  listQueues,
  listSchedulers,
  recordObservedJobs,
  recordObservedQueues,
  recordObservedSchedulers,
  searchJobs,
} from "./queue-store.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-sqlite.db`;

const baseConfig: Config = {
  redis: { host: "localhost", port: 6379, db: 0 },
  pollInterval: 3000,
  prefix: "bull",
  cacheTtlMs: 24 * 60 * 60 * 1000,
};

let ctx: Context;

function cleanupDb(path = TEST_DB_PATH): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // ignore
    }
  }
}

beforeEach(() => {
  ctx = createContext(baseConfig, { dbPath: TEST_DB_PATH });
});

afterEach(async () => {
  ctx.db.close();
  await ctx.redis.quit().catch(() => {});
  cleanupDb();
});

describe("createSqliteDb", () => {
  it("creates cache tables with last_observed_at", () => {
    const jobColumns = ctx.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const queueColumns = ctx.db.prepare("PRAGMA table_info(queues)").all() as Array<{
      name: string;
    }>;
    const schedulerColumns = ctx.db.prepare("PRAGMA table_info(schedulers)").all() as Array<{
      name: string;
    }>;

    expect(jobColumns.map((c) => c.name)).toContain("last_observed_at");
    expect(queueColumns.map((c) => c.name)).toContain("last_observed_at");
    expect(schedulerColumns.map((c) => c.name)).toContain("last_observed_at");
    expect(jobColumns.map((c) => c.name)).toContain("removed_at");
  });

  it("migrates legacy rows as fresh for one TTL window", () => {
    const path = `${import.meta.dirname}/legacy-cache.db`;
    cleanupDb(path);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT NOT NULL,
        queue TEXT NOT NULL,
        name TEXT,
        state TEXT NOT NULL,
        timestamp INTEGER,
        data_preview TEXT,
        PRIMARY KEY (queue, id)
      );
      INSERT INTO jobs (id, queue, name, state, timestamp, data_preview)
      VALUES ('1', 'email', 'legacy', 'completed', 1000, '{"ok":true}');
    `);
    legacy.close();

    const before = Date.now();
    const migrated = createSqliteDb(baseConfig, path);
    const after = Date.now();
    const row = migrated.prepare("SELECT last_observed_at FROM jobs WHERE id = '1'").get() as {
      last_observed_at: number;
    };

    expect(row.last_observed_at).toBeGreaterThanOrEqual(before);
    expect(row.last_observed_at).toBeLessThanOrEqual(after);
    migrated.close();
    cleanupDb(path);
  });
});

describe("queue-store observations and reads", () => {
  it("records and lists observed queues without deleting missing queues", () => {
    recordObservedQueues(
      ctx,
      [
        {
          name: "email",
          counts: { wait: 1, active: 2, completed: 3, failed: 4, delayed: 5, schedulers: 6 },
          isPaused: false,
          total: 15,
        },
      ],
      { observedAt: 1000 },
    );
    recordObservedQueues(ctx, [], { observedAt: 2000 });

    expect(listQueues(ctx).map((queue) => queue.name)).toEqual(["email"]);
    expect(listQueues(ctx)[0]!.lastObservedAt).toBe(1000);
  });

  it("records jobs with full details and clears omitted optional fields on latest observation", () => {
    recordObservedJobs(
      ctx,
      "email",
      [
        {
          id: "42",
          name: "send",
          state: "failed",
          timestamp: 1000,
          data: { to: "a@example.com" },
          opts: { attempts: 3 },
          attemptsMade: 2,
          failedReason: "boom",
          stacktrace: ["line 1"],
          returnvalue: { ok: false },
          processedOn: 1100,
          finishedOn: 1200,
          progress: { step: 2 },
          repeatJobKey: "repeat-key",
          delay: 50,
        },
      ],
      { observedAt: 5000 },
    );

    expect(getJob(ctx, "email", "42")).toMatchObject({
      id: "42",
      data: { to: "a@example.com" },
      opts: { attempts: 3 },
      attemptsMade: 2,
      failedReason: "boom",
      stacktrace: ["line 1"],
      returnvalue: { ok: false },
      processedOn: 1100,
      finishedOn: 1200,
      progress: { step: 2 },
      repeatJobKey: "repeat-key",
      delay: 50,
      lastObservedAt: 5000,
    });

    recordObservedJobs(
      ctx,
      "email",
      [{ id: "42", name: "send", state: "completed", timestamp: 2000 }],
      { observedAt: 6000 },
    );

    const detail = getJob(ctx, "email", "42");
    expect(detail).toMatchObject({
      id: "42",
      state: "completed",
      timestamp: 2000,
      data: null,
      opts: null,
      attemptsMade: 0,
      lastObservedAt: 6000,
    });
    expect(detail?.failedReason).toBeUndefined();
    expect(detail?.stacktrace).toBeUndefined();
  });

  it("lists and searches jobs from SQLite", () => {
    recordObservedJobs(
      ctx,
      "email",
      [
        { id: "old", name: "welcome", state: "waiting", timestamp: 1000, data: { kind: "hello" } },
        { id: "new", name: "receipt", state: "completed", timestamp: 2000, data: { kind: "paid" } },
      ],
      { observedAt: 3000 },
    );

    expect(listJobs(ctx, "email", { page: 1, pageSize: 1 }).jobs.map((job) => job.id)).toEqual([
      "new",
    ]);
    expect(listJobs(ctx, "email", { state: "wait" }).jobs.map((job) => job.id)).toEqual(["old"]);
    expect(searchJobs(ctx, "email", "paid").jobs.map((job) => job.id)).toEqual(["new"]);
  });

  it("records schedulers without deleting missing schedulers", () => {
    recordObservedSchedulers(ctx, "email", [{ key: "daily", name: "daily" }], {
      observedAt: 1000,
    });
    recordObservedSchedulers(ctx, "email", [], { observedAt: 2000 });

    const result = listSchedulers(ctx, "email");
    expect(result.schedulers.map((scheduler) => scheduler.key)).toEqual(["daily"]);
    expect(result.schedulers[0]!.lastObservedAt).toBe(1000);
  });
});

describe("queue-store TTL cleanup", () => {
  it("deletes stale queues, cascades their schedulers, and leaves jobs for that queue", () => {
    ctx.db.close();
    ctx = createContext({ ...baseConfig, cacheTtlMs: 1000 }, { dbPath: TEST_DB_PATH });

    recordObservedQueues(
      ctx,
      [
        {
          name: "email",
          counts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 1 },
          isPaused: false,
          total: 0,
        },
      ],
      { observedAt: 1000 },
    );
    recordObservedSchedulers(ctx, "email", [{ key: "daily", name: "daily" }], {
      observedAt: 1500,
    });
    recordObservedJobs(ctx, "email", [{ id: "1", name: "job", state: "active", timestamp: 1000 }], {
      observedAt: 2500,
    });

    const result = expireStaleRecords(ctx, { now: 2101 });

    expect(result).toEqual({ queuesDeleted: 1, schedulersDeleted: 1, jobsDeleted: 0 });
    expect(listQueues(ctx)).toEqual([]);
    expect(listSchedulers(ctx, "email").total).toBe(0);
    expect(listJobs(ctx, "email").total).toBe(1);
  });

  it("reports stale cache state for rows not yet cleaned", () => {
    ctx.db.close();
    ctx = createContext({ ...baseConfig, cacheTtlMs: 1000 }, { dbPath: TEST_DB_PATH });

    recordObservedQueues(
      ctx,
      [
        {
          name: "email",
          counts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 0 },
          isPaused: false,
          total: 0,
        },
      ],
      { observedAt: 1000 },
    );
    recordObservedJobs(
      ctx,
      "email",
      [
        { id: "stale", name: "stale", state: "completed", timestamp: 1 },
        { id: "fresh", name: "fresh", state: "active", timestamp: 2 },
      ],
      { observedAt: 1000 },
    );
    recordObservedJobs(
      ctx,
      "email",
      [{ id: "fresh", name: "fresh", state: "active", timestamp: 2 }],
      { observedAt: Date.now() },
    );

    const state = getCacheState(ctx, "email");

    expect(state.cacheTtlMs).toBe(1000);
    expect(state.queue.exists).toBe(true);
    expect(state.jobs.count).toBe(2);
    expect(state.jobs.staleCount).toBeGreaterThanOrEqual(1);
    expect(state.schedulers.count).toBe(0);
  });
});
