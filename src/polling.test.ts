import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { unlinkSync } from "node:fs";
import { createContext, type Context } from "./context.js";
import type { QueueStats } from "./data/queues.js";
import type { JobSchedulerSummary } from "./data/schedulers.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-polling.db`;

const zeroRates = {
  enqueuedPerMin: 0,
  enqueuedPerSec: 0,
  dequeuedPerMin: 0,
  dequeuedPerSec: 0,
};

const queueStats = (name: string): QueueStats => ({
  name,
  counts: { wait: 1, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 0 },
  isPaused: false,
  total: 1,
});

interface MockState {
  observedQueues: QueueStats[];
  getAllQueueStatsError: string | null;
  getQueueError: string | null;
  activeJobs: Array<{ id: string; name: string; timestamp: number; data?: unknown }>;
  activeTotal: number;
  schedulers: JobSchedulerSummary[];
  schedulersError: string | null;
}

const mockState: MockState = {
  observedQueues: [],
  getAllQueueStatsError: null,
  getQueueError: null,
  activeJobs: [],
  activeTotal: 0,
  schedulers: [],
  schedulersError: null,
};

mock.module("./data/queues.js", () => ({
  getAllQueueStats: async () => {
    if (mockState.getAllQueueStatsError) throw new Error(mockState.getAllQueueStatsError);
    return mockState.observedQueues;
  },
  getQueue: () => {
    if (mockState.getQueueError) throw new Error(mockState.getQueueError);
    return {
      getJobCounts: async () => ({ active: mockState.activeTotal }),
      getActive: async () => mockState.activeJobs,
      getWaiting: async () => [],
      getCompleted: async () => [],
      getFailed: async () => [],
      getDelayed: async () => [],
      getPrioritized: async () => [],
      getJobSchedulers: async (
        start: number = 0,
        end: number = mockState.schedulers.length - 1,
      ) => {
        if (mockState.schedulersError) throw new Error(mockState.schedulersError);
        return mockState.schedulers.slice(start, end + 1);
      },
      getJobSchedulersCount: async () => {
        if (mockState.schedulersError) throw new Error(mockState.schedulersError);
        return mockState.schedulers.length;
      },
    };
  },
}));

// Import after mocks are registered.
import { pollingManager } from "./polling.js";
import { upsertJobs, upsertQueueStats, upsertSchedulers } from "./data/sqlite.js";
import { stateManager } from "./state.js";

function resetAppState(): void {
  stateManager.setState({
    connected: true,
    error: null,
    globalMetrics: {
      queueCount: 0,
      jobCounts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 },
      rates: zeroRates,
    },
    queues: [],
    selectedQueueIndex: 0,
    jobs: [],
    jobsTotal: 0,
    jobsPage: 1,
    jobsTotalPages: 0,
    jobsStatus: "latest",
    selectedJobIndex: 0,
    jobDetail: null,
    showJobDetail: false,
    schedulers: [],
    schedulersTotal: 0,
    schedulersPage: 1,
    schedulersTotalPages: 0,
    selectedSchedulerIndex: 0,
    schedulerDetail: null,
    showSchedulerDetail: false,
    focusedPane: "queues",
    showConfirmDelete: false,
    showPageJump: false,
    pageJumpInput: "",
    isLoading: false,
  });
}

let ctx: Context;

beforeEach(() => {
  ctx = createContext(
    {
      redis: { host: "localhost", port: 6379, db: 0 },
      pollInterval: 3000,
      prefix: "bull",
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    },
    { dbPath: TEST_DB_PATH },
  );
  pollingManager.start(ctx);
  mockState.observedQueues = [];
  mockState.getAllQueueStatsError = null;
  mockState.getQueueError = null;
  mockState.activeJobs = [];
  mockState.activeTotal = 0;
  mockState.schedulers = [];
  mockState.schedulersError = null;
  resetAppState();
});

afterEach(async () => {
  pollingManager.stop();
  ctx.db.close();
  await ctx.redis.quit().catch(() => {});
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

// `mock.module` is process-global in Bun, so without restore the stub
// for ./data/queues.js leaks into later test files (any test running after
// this one would see undefined for discoverQueueNames, getQueueStats, etc.).
afterAll(() => {
  mock.restore();
});

describe("pollingManager", () => {
  it("renders Redis observations and keeps Redis pagination totals on the connected path", async () => {
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.activeTotal = 100;
    mockState.activeJobs = [{ id: "fresh", name: "fresh-job", timestamp: 1000 }];

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(true);
    expect(state.jobs).toEqual([
      { id: "fresh", name: "fresh-job", state: "active", timestamp: 1000 },
    ]);
    expect(state.jobsTotal).toBe(100);
    expect(state.jobsTotalPages).toBe(4);
  });

  it("renders the observed Redis jobs page when the SQLite cache is sparse", async () => {
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.activeTotal = 75;
    mockState.activeJobs = [{ id: "page-3", name: "third-page-job", timestamp: 3000 }];
    stateManager.setState({
      jobsStatus: "active",
      jobsPage: 3,
    });

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(true);
    expect(state.jobs).toEqual([
      { id: "page-3", name: "third-page-job", state: "active", timestamp: 3000 },
    ]);
    expect(state.jobsTotal).toBe(75);
    expect(state.jobsTotalPages).toBe(3);
  });

  it("does not render stale cached jobs when Redis observes an empty page", async () => {
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.activeTotal = 0;
    mockState.activeJobs = [];
    upsertJobs(ctx, "email", [{ id: "stale", name: "stale-job", state: "active", timestamp: 1000 }]);
    stateManager.setState({
      jobsStatus: "active",
    });

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(true);
    expect(state.jobs).toEqual([]);
    expect(state.jobsTotal).toBe(0);
    expect(state.jobsTotalPages).toBe(0);
  });

  it("marks disconnected and renders last-known store jobs when Redis job observation fails", async () => {
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.getQueueError = "redis job fetch failed";
    upsertJobs(ctx, "email", [{ id: "cached", name: "job-cached", state: "waiting", timestamp: 1000 }]);

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(false);
    expect(state.error).toBe("redis job fetch failed");
    expect(state.queues).toEqual([email]);
    expect(state.jobs).toEqual([
      { id: "cached", name: "job-cached", state: "waiting", timestamp: 1000 },
    ]);
    expect(state.jobsTotal).toBe(1);
    expect(state.jobsTotalPages).toBe(1);
    expect(state.schedulers).toEqual([]);
  });

  it("renders last-known schedulers from SQLite during disconnected fallback", async () => {
    const email = queueStats("email");
    const cachedScheduler: JobSchedulerSummary = {
      key: "every-hour",
      name: "every-hour",
      every: 3_600_000,
    };
    mockState.getAllQueueStatsError = "redis down";
    upsertQueueStats(ctx, [email]);
    upsertSchedulers(ctx, "email", [cachedScheduler]);
    stateManager.setState({
      queues: [email],
      jobsStatus: "schedulers",
      // Simulate a stale in-memory copy: SQLite is the source of truth now.
      schedulers: [{ key: "old", name: "old" }],
      schedulersTotal: 1,
      schedulersTotalPages: 1,
    });

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(false);
    expect(state.error).toBe("redis down");
    expect(state.jobs).toEqual([]);
    expect(state.jobsTotal).toBe(0);
    expect(state.jobsTotalPages).toBe(0);
    expect(state.schedulers).toEqual([cachedScheduler]);
    expect(state.schedulersTotal).toBe(1);
    expect(state.schedulersTotalPages).toBe(1);
  });

  it("persists schedulers to SQLite on the connected schedulers path", async () => {
    const email = queueStats("email");
    const scheduler: JobSchedulerSummary = {
      key: "nightly",
      name: "nightly",
      pattern: "0 0 * * *",
    };
    mockState.observedQueues = [email];
    mockState.schedulers = [scheduler];
    stateManager.setState({
      jobsStatus: "schedulers",
      schedulersPage: 1,
    });

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(true);
    expect(state.schedulers).toEqual([scheduler]);
    expect(state.schedulersTotal).toBe(1);
    expect(state.schedulersTotalPages).toBe(1);
    expect(state.jobs).toEqual([]);
  });

  it("renders scheduler pages beyond the default 1000-row bulk cap", async () => {
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.schedulers = Array.from({ length: 1001 }, (_, i) => ({
      key: `s-${String(i).padStart(4, "0")}`,
      name: `scheduler-${i}`,
    }));
    stateManager.setState({
      jobsStatus: "schedulers",
      schedulersPage: 41,
    });

    await pollingManager.poll();

    const state = stateManager.getState();
    expect(state.connected).toBe(true);
    expect(state.schedulers).toEqual([{ key: "s-1000", name: "scheduler-1000" }]);
    expect(state.schedulersTotal).toBe(1001);
    expect(state.schedulersTotalPages).toBe(41);
  });

  it("recovers from disconnect: keeps last-known state, then refreshes when Redis returns", async () => {
    // Cycle 1: connected — populate state.
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.activeTotal = 10;
    mockState.activeJobs = [{ id: "j1", name: "job-1", timestamp: 1000 }];

    await pollingManager.poll();

    const afterFirstPoll = stateManager.getState();
    expect(afterFirstPoll.connected).toBe(true);
    expect(afterFirstPoll.queues).toEqual([email]);
    expect(afterFirstPoll.jobs).toEqual([
      { id: "j1", name: "job-1", state: "active", timestamp: 1000 },
    ]);
    expect(afterFirstPoll.jobsTotal).toBe(10);

    // Cycle 2: Redis goes down — last-known state should remain visible.
    mockState.getAllQueueStatsError = "connection refused";

    await pollingManager.poll();

    const afterFailure = stateManager.getState();
    expect(afterFailure.connected).toBe(false);
    expect(afterFailure.error).toBe("connection refused");
    // Queue still visible (from SQLite).
    expect(afterFailure.queues).toEqual([email]);
    // Last-known job still visible (from SQLite — j1 was persisted in cycle 1).
    expect(afterFailure.jobs).toEqual([
      { id: "j1", name: "job-1", state: "active", timestamp: 1000 },
    ]);
    // Rates explicitly zeroed during disconnect.
    expect(afterFailure.globalMetrics?.rates).toEqual(zeroRates);

    // Cycle 3: Redis recovers with fresh data.
    mockState.getAllQueueStatsError = null;
    mockState.activeTotal = 11;
    mockState.activeJobs = [{ id: "j2", name: "job-2", timestamp: 2000 }];

    await pollingManager.poll();

    const afterRecovery = stateManager.getState();
    expect(afterRecovery.connected).toBe(true);
    expect(afterRecovery.error).toBeNull();
    expect(afterRecovery.jobsTotal).toBe(11);
    // Fresh job rendered; cached job still in SQLite but the new one sorts
    // higher by timestamp and the "latest" view returns both.
    const renderedIds = afterRecovery.jobs.map((j) => j.id);
    expect(renderedIds).toContain("j2");
  });
});
