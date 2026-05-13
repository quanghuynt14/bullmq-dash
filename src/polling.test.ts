import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { unlinkSync } from "node:fs";
import { setConfig } from "./config.js";
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
}

const mockState: MockState = {
  observedQueues: [],
  getAllQueueStatsError: null,
  getQueueError: null,
  activeJobs: [],
  activeTotal: 0,
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
    };
  },
}));

// Import after mocks are registered.
import { pollingManager } from "./polling.js";
import { closeSqliteDb, createSqliteDb, upsertJobs, upsertQueueStats } from "./data/sqlite.js";
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

beforeEach(() => {
  setConfig({
    redis: { host: "localhost", port: 6379, db: 0 },
    pollInterval: 3000,
    prefix: "bull",
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  });
  createSqliteDb(TEST_DB_PATH);
  mockState.observedQueues = [];
  mockState.getAllQueueStatsError = null;
  mockState.getQueueError = null;
  mockState.activeJobs = [];
  mockState.activeTotal = 0;
  resetAppState();
});

afterEach(() => {
  closeSqliteDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("pollingManager", () => {
  it("keeps Redis pagination totals when rendering connected rows from the store", async () => {
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

  it("marks disconnected and renders last-known store jobs when Redis job observation fails", async () => {
    const email = queueStats("email");
    mockState.observedQueues = [email];
    mockState.getQueueError = "redis job fetch failed";
    upsertJobs("email", [{ id: "cached", name: "job-cached", state: "waiting", timestamp: 1000 }]);

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

  it("clears stale scheduler rows during disconnected fallback", async () => {
    const email = queueStats("email");
    const staleScheduler: JobSchedulerSummary = { key: "old", name: "old" };
    mockState.getAllQueueStatsError = "redis down";
    upsertQueueStats([email]);
    stateManager.setState({
      queues: [email],
      jobsStatus: "schedulers",
      schedulers: [staleScheduler],
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
    expect(state.schedulers).toEqual([]);
    expect(state.schedulersTotal).toBe(0);
    expect(state.schedulersTotalPages).toBe(0);
  });
});
