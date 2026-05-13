import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { unlinkSync } from "node:fs";
import { setConfig } from "../config.js";

// Mutable state the mocks read from. Tests reset this in beforeEach.
interface MockState {
  batches: Array<Array<{ id: string; state: string }>>;
  queues: string[];
  jobsError: string | null;
  discoverError: string | null;
  /** If set, getAllJobIds awaits this before yielding its first batch. */
  gate: Promise<void> | null;
}

const mockState: MockState = {
  batches: [],
  queues: [],
  jobsError: null,
  discoverError: null,
  gate: null,
};

mock.module("./jobs.js", () => ({
  getAllJobIds: async function* (_queueName: string) {
    if (mockState.gate) await mockState.gate;
    if (mockState.jobsError) throw new Error(mockState.jobsError);
    for (const batch of mockState.batches) {
      yield batch;
    }
  },
}));

mock.module("./queues.js", () => ({
  discoverQueueNames: async () => {
    if (mockState.discoverError) throw new Error(mockState.discoverError);
    return mockState.queues;
  },
}));

// Import AFTER mocks are registered.
import {
  syncQueue,
  fullSync,
  markPolledWrites,
  __resetRecentlyPolledForTests,
  __resetSyncLockForTests,
  __forceSyncLockForTests,
} from "./sync.js";
import {
  closeSqliteDb,
  createSqliteDb,
  getJobFromDb,
  getSqliteDb,
  softDeleteJobsByIds,
  upsertJobs,
  type JobRow,
} from "./sqlite.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-sync.db`;

// Sync logs to console.error on failure paths; silence them in tests so the
// output isn't noisy. Original is restored in afterEach.
const realConsoleError = console.error;

beforeEach(() => {
  setConfig({
    redis: { host: "localhost", port: 6379, db: 0 },
    pollInterval: 3000,
    prefix: "bull",
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  });
  createSqliteDb(TEST_DB_PATH);
  mockState.batches = [];
  mockState.queues = [];
  mockState.jobsError = null;
  mockState.discoverError = null;
  mockState.gate = null;
  __resetRecentlyPolledForTests();
  __resetSyncLockForTests();
  console.error = () => {};
});

afterEach(() => {
  console.error = realConsoleError;
  closeSqliteDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("syncQueue", () => {
  it("inserts new jobs as stubs", async () => {
    mockState.batches = [
      [
        { id: "1", state: "active" },
        { id: "2", state: "completed" },
      ],
    ];

    const result = await syncQueue("q");

    expect(result.error).toBeUndefined();
    expect(result.inserted).toBe(2);
    expect(result.total).toBe(2);

    const rows = getSqliteDb()
      .prepare("SELECT id, state FROM jobs WHERE queue = ? ORDER BY id")
      .all("q") as Array<{ id: string; state: string }>;
    expect(rows).toEqual([
      { id: "1", state: "active" },
      { id: "2", state: "completed" },
    ]);
  });

  it("sets result.error and resets syncInProgress on failure", async () => {
    mockState.jobsError = "redis disconnect";

    const first = await syncQueue("q");
    expect(first.error).toContain("redis disconnect");

    // Guard must be released — a subsequent successful run should work.
    mockState.jobsError = null;
    mockState.batches = [[{ id: "1", state: "active" }]];
    const second = await syncQueue("q");
    expect(second.error).toBeUndefined();
    expect(second.inserted).toBe(1);
  });

  it("steals a stale lock held past the timeout", async () => {
    // Simulate a previous sync that hung: lock acquired 11 minutes ago.
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    __forceSyncLockForTests(elevenMinutesAgo);

    mockState.batches = [[{ id: "1", state: "active" }]];

    const result = await syncQueue("q");
    expect(result.error).toBeUndefined();
    expect(result.inserted).toBe(1);
  });

  it("does NOT steal a lock that was just acquired", async () => {
    // Simulate an actively-running sync: lock acquired moments ago.
    __forceSyncLockForTests(Date.now() - 100);

    mockState.batches = [[{ id: "1", state: "active" }]];

    const result = await syncQueue("q");
    expect(result.error).toContain("another sync is in progress");
  });

  it("rejects overlapping calls with 'in progress'", async () => {
    let releaseGate!: () => void;
    mockState.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    mockState.batches = [[{ id: "1", state: "active" }]];

    const first = syncQueue("q");
    // Let the event loop start `first` so it sets syncInProgress.
    await Promise.resolve();

    const second = await syncQueue("q");
    expect(second.error).toContain("another sync is in progress");

    releaseGate();
    const firstResult = await first;
    expect(firstResult.error).toBeUndefined();
  });

  it("preserves state for jobs polling just refreshed", async () => {
    // Simulate: polling just wrote state=completed with fresh data.
    upsertJobs("q", [{ id: "1", name: "job-a", state: "completed", timestamp: 5000 }]);
    markPolledWrites("q", ["1"]);

    // Sync's staging snapshot has the older state=active.
    mockState.batches = [[{ id: "1", state: "active" }]];

    const result = await syncQueue("q");
    expect(result.error).toBeUndefined();
    // stateUpdated should be 0: the changed-row was filtered out
    expect(result.stateUpdated).toBe(0);

    const row = getSqliteDb()
      .prepare("SELECT * FROM jobs WHERE queue = ? AND id = ?")
      .get("q", "1") as JobRow;
    expect(row.state).toBe("completed"); // NOT overwritten
    expect(row.name).toBe("job-a");
  });

  it("does not soft-delete jobs polling just inserted that staging missed", async () => {
    // Polling inserts a fresh job — sync's staging snapshot won't include it.
    upsertJobs("q", [{ id: "99", name: "fresh", state: "active", timestamp: 9000 }]);
    markPolledWrites("q", ["99"]);

    // Staging has a totally different set — under naive rules, "99" is stale.
    mockState.batches = [[{ id: "1", state: "active" }]];

    const result = await syncQueue("q");
    expect(result.error).toBeUndefined();
    expect(result.softDeleted).toBe(0);

    const row = getJobFromDb("q", "99");
    expect(row).not.toBeNull();
    expect(row!.removed_at).toBeNull();
  });

  it("soft-deletes jobs missing from Redis instead of hard-deleting", async () => {
    // Pre-existing rows in SQLite — reconciliation will see only id=1 in Redis.
    upsertJobs("q", [
      { id: "1", name: "still-here", state: "active", timestamp: 1000 },
      { id: "2", name: "gone-from-redis", state: "completed", timestamp: 2000 },
    ]);
    mockState.batches = [[{ id: "1", state: "active" }]];

    const before = Date.now();
    const result = await syncQueue("q");
    const after = Date.now();

    expect(result.error).toBeUndefined();
    expect(result.softDeleted).toBe(1);

    // Row physically present, with removed_at stamped at sync time.
    const gone = getJobFromDb("q", "2", { view: "all" });
    expect(gone).not.toBeNull();
    expect(gone!.removed_at).not.toBeNull();
    expect(gone!.removed_at!).toBeGreaterThanOrEqual(before);
    expect(gone!.removed_at!).toBeLessThanOrEqual(after);

    // Default-view reads must not surface the soft-deleted row.
    expect(getJobFromDb("q", "2")).toBeNull();
  });

  it("throws when a soft-deleted id reappears in Redis", async () => {
    upsertJobs("q", [
      { id: "1", name: "active", state: "active", timestamp: 1000 },
      { id: "2", name: "ghost", state: "completed", timestamp: 2000 },
    ]);
    softDeleteJobsByIds("q", ["2"], 100);

    // Resurrection: id=2 is soft-deleted in cache but reappears in Redis.
    mockState.batches = [
      [
        { id: "1", state: "active" },
        { id: "2", state: "completed" },
      ],
    ];

    const thrown = await syncQueue("q").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;

    expect(message.toLowerCase()).toContain("resurrect");
    // The error message must name the queue and the offending id so operators
    // can grep logs after the throw.
    expect(message).toContain('"q"');
    expect(message).toContain("2");

    // Soft-delete must NOT be cleared — the row stays soft-deleted.
    const row = getJobFromDb("q", "2", { view: "all" });
    expect(row!.removed_at).toBe(100);
  });

  it("lists every offending id in the resurrection error message", async () => {
    upsertJobs("q", [
      { id: "1", name: "active", state: "active", timestamp: 1 },
      { id: "2", name: "ghost-a", state: "completed", timestamp: 2 },
      { id: "3", name: "ghost-b", state: "completed", timestamp: 3 },
    ]);
    softDeleteJobsByIds("q", ["2", "3"], 100);

    mockState.batches = [
      [
        { id: "1", state: "active" },
        { id: "2", state: "completed" },
        { id: "3", state: "completed" },
      ],
    ];

    const thrown = await syncQueue("q").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;

    // Both offending ids must appear so operators can grep for the violation.
    expect(message).toContain("2");
    expect(message).toContain("3");
  });

  it("aborts with a clear error when closeSqliteDb fires mid-sync", async () => {
    let releaseGate!: () => void;
    mockState.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    mockState.batches = [[{ id: "1", state: "active" }]];

    const pending = syncQueue("q");
    // Let syncQueue reach the gate (past createSyncStaging + lock acquire).
    await Promise.resolve();

    // Simulate a shutdown path closing the connection mid-sync.
    closeSqliteDb();
    releaseGate();

    const result = await pending;
    expect(result.error).toContain("connection was closed mid-sync");

    // Lock must be released so a subsequent sync can proceed.
    // Re-open the DB (closeSqliteDb was destructive) and try again.
    createSqliteDb(TEST_DB_PATH);
    mockState.gate = null;
    mockState.batches = [[{ id: "2", state: "active" }]];
    const second = await syncQueue("q");
    expect(second.error).toBeUndefined();
  });

  it("still applies state change for jobs polling touched BEFORE sync started", async () => {
    // Polling wrote this job well before sync starts.
    upsertJobs("q", [{ id: "1", name: "job-a", state: "active", timestamp: 1000 }]);
    markPolledWrites("q", ["1"]);

    // Wait so the polled-timestamp falls before syncStart.
    // markPolledWrites uses Date.now(); ensure at least 1ms elapses.
    await new Promise((r) => setTimeout(r, 5));

    mockState.batches = [[{ id: "1", state: "completed" }]];

    const result = await syncQueue("q");
    expect(result.error).toBeUndefined();
    expect(result.stateUpdated).toBe(1);

    const row = getSqliteDb()
      .prepare("SELECT state FROM jobs WHERE queue = ? AND id = ?")
      .get("q", "1") as { state: string };
    expect(row.state).toBe("completed");
  });
});

describe("fullSync", () => {
  it("aggregates per-queue errors without aborting", async () => {
    mockState.queues = ["ok-queue", "fail-queue"];
    // getAllJobIds is called once per queue. We need per-call behavior, so
    // use an error-flag toggle via beforeEach + a sequence-aware override.
    let call = 0;
    mock.module("./jobs.js", () => ({
      getAllJobIds: async function* (_q: string) {
        call++;
        if (call === 2) throw new Error("boom");
        yield [{ id: "1", state: "active" }];
      },
    }));

    const result = await fullSync();

    expect(result.queues).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.queue).toBe("fail-queue");
    expect(result.errors[0]!.error).toContain("boom");
    expect(result.totalInserted).toBe(1); // only ok-queue counted
  });

  it("surfaces discovery failures as a queue-less error entry", async () => {
    mockState.discoverError = "redis scan failed";

    const result = await fullSync();

    expect(result.queues).toBe(0);
    expect(result.totalInserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.queue).toBe("");
    expect(result.errors[0]!.error).toContain("redis scan failed");
  });

  it("returns empty errors array when every queue succeeds", async () => {
    mockState.queues = ["q1", "q2"];
    // Reset the jobs mock in case a prior test replaced it.
    mock.module("./jobs.js", () => ({
      getAllJobIds: async function* (_q: string) {
        yield [{ id: "1", state: "active" }];
      },
    }));

    const result = await fullSync();
    expect(result.queues).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it("rethrows resurrected ids after syncing remaining queues without compacting evidence", async () => {
    upsertJobs("bad", [{ id: "ghost", name: "ghost", state: "completed", timestamp: 1 }]);
    upsertJobs("good", [{ id: "expired", name: "old", state: "completed", timestamp: 1 }]);
    softDeleteJobsByIds("bad", ["ghost"], 1);
    softDeleteJobsByIds("good", ["expired"], 1);

    setConfig({
      redis: { host: "localhost", port: 6379, db: 0 },
      pollInterval: 3000,
      prefix: "bull",
      retentionMs: 10,
    });

    mockState.queues = ["bad", "good"];
    mock.module("./jobs.js", () => ({
      getAllJobIds: async function* (q: string) {
        if (q === "bad") yield [{ id: "ghost", state: "completed" }];
        if (q === "good") yield [{ id: "live", state: "active" }];
      },
    }));

    await expect(fullSync()).rejects.toThrow(/bad: .*resurrect/i);

    // The bad queue is still soft-deleted, but the unrelated queue still synced.
    // This row is past retention; compaction must not erase it because that
    // would let the same Redis ID insert as a brand-new live job on next sync.
    expect(getJobFromDb("bad", "ghost", { view: "all" })!.removed_at).toBe(1);
    expect(getJobFromDb("good", "live")).not.toBeNull();
    // Compaction is skipped for the whole cycle when an invariant fails.
    expect(getJobFromDb("good", "expired", { view: "all" })).not.toBeNull();
  });

  it("compacts rows past retentionMs once after all queues reconcile", async () => {
    // Pre-stamp soft-deleted rows on two queues, both well past retention.
    upsertJobs("q1", [
      { id: "expired", name: "a", state: "completed", timestamp: 1 },
      { id: "live", name: "b", state: "active", timestamp: 2 },
    ]);
    upsertJobs("q2", [
      { id: "expired", name: "c", state: "completed", timestamp: 1 },
      { id: "live", name: "d", state: "active", timestamp: 2 },
    ]);
    softDeleteJobsByIds("q1", ["expired"], 1);
    softDeleteJobsByIds("q2", ["expired"], 1);

    setConfig({
      redis: { host: "localhost", port: 6379, db: 0 },
      pollInterval: 3000,
      prefix: "bull",
      retentionMs: 10, // anything stamped > 10ms ago is purged
    });

    mockState.queues = ["q1", "q2"];
    mock.module("./jobs.js", () => ({
      getAllJobIds: async function* (_q: string) {
        yield [{ id: "live", state: "active" }];
      },
    }));

    const result = await fullSync();
    expect(result.errors).toEqual([]);
    expect(result.totalCompacted).toBe(2);

    expect(getJobFromDb("q1", "expired", { view: "all" })).toBeNull();
    expect(getJobFromDb("q2", "expired", { view: "all" })).toBeNull();
    expect(getJobFromDb("q1", "live")).not.toBeNull();
    expect(getJobFromDb("q2", "live")).not.toBeNull();
  });
});
