import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Shape of the fake Job objects the mocked queue returns.
interface FakeJob {
  id: string | undefined;
  name: string;
  finishedOn?: number;
  timestamp?: number;
  retry: (state: string) => Promise<void>;
}

interface MockState {
  failedJobs: FakeJob[];
  totalFailedCount: number;
  retryBehavior: (job: FakeJob) => Promise<void>;
}

const mockState: MockState = {
  failedJobs: [],
  totalFailedCount: 0,
  retryBehavior: async () => {},
};

mock.module("./queues.js", () => ({
  getQueue: (_name: string) => ({
    getFailed: async (start: number, end: number) => {
      // Match BullMQ's getFailed(0, end) contract: inclusive end index.
      return mockState.failedJobs.slice(start, end + 1);
    },
    getJobCounts: async (..._states: string[]) => ({ failed: mockState.totalFailedCount }),
  }),
}));

// Import AFTER mocks are registered.
import { retryFailedJobs } from "./jobs.js";

function makeJob(
  id: string | undefined,
  overrides: Partial<Omit<FakeJob, "retry">> = {},
  retryImpl?: (state: string) => Promise<void>,
): FakeJob {
  const job: FakeJob = {
    id,
    name: overrides.name ?? "job",
    finishedOn: overrides.finishedOn,
    timestamp: overrides.timestamp,
    retry: retryImpl ?? (async () => mockState.retryBehavior(job)),
  };
  return job;
}

beforeEach(() => {
  mockState.failedJobs = [];
  mockState.totalFailedCount = 0;
  mockState.retryBehavior = async () => {};
});

afterEach(() => {
  // Reset between tests — failedJobs is reassigned in beforeEach so this is belt-and-braces.
  mockState.failedJobs = [];
});

describe("retryFailedJobs — dry-run branch", () => {
  it("reports matched without invoking retry() on any job", async () => {
    let retryCalls = 0;
    const jobs = [
      makeJob("a", {}, async () => {
        retryCalls += 1;
      }),
      makeJob("b", {}, async () => {
        retryCalls += 1;
      }),
    ];
    mockState.failedJobs = jobs;
    mockState.totalFailedCount = 2;

    const result = await retryFailedJobs("q", { dryRun: true });

    expect(retryCalls).toBe(0);
    expect(result.matched).toBe(2);
    expect(result.retried).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.sampleJobIds).toEqual(["a", "b"]);
    expect(result.totalFailed).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("samples up to 5 matched IDs", async () => {
    mockState.failedJobs = Array.from({ length: 10 }, (_, i) => makeJob(`j${i}`));
    mockState.totalFailedCount = 10;

    const result = await retryFailedJobs("q", { dryRun: true });

    expect(result.sampleJobIds).toEqual(["j0", "j1", "j2", "j3", "j4"]);
  });
});

describe("retryFailedJobs — filters", () => {
  it("--since excludes jobs older than the cutoff, using finishedOn", async () => {
    const now = Date.now();
    mockState.failedJobs = [
      makeJob("fresh", { finishedOn: now - 10 * 60 * 1000 }), // 10 min ago — inside 1h
      makeJob("stale", { finishedOn: now - 2 * 60 * 60 * 1000 }), // 2h ago — outside 1h
    ];
    mockState.totalFailedCount = 2;

    const result = await retryFailedJobs("q", { since: "1h", dryRun: true });

    expect(result.matched).toBe(1);
    expect(result.sampleJobIds).toEqual(["fresh"]);
  });

  it("falls back to timestamp when finishedOn is missing", async () => {
    const now = Date.now();
    mockState.failedJobs = [
      makeJob("a", { timestamp: now - 30 * 60 * 1000 }), // finishedOn missing, timestamp 30 min ago
    ];
    mockState.totalFailedCount = 1;

    const result = await retryFailedJobs("q", { since: "1h", dryRun: true });

    expect(result.matched).toBe(1);
  });

  it("excludes jobs with neither finishedOn nor timestamp when --since is set", async () => {
    mockState.failedJobs = [makeJob("orphan")]; // both timestamps undefined -> treated as 0
    mockState.totalFailedCount = 1;

    const result = await retryFailedJobs("q", { since: "1h", dryRun: true });

    expect(result.matched).toBe(0);
  });

  it("--name filters by exact match only", async () => {
    mockState.failedJobs = [
      makeJob("a", { name: "welcome-email" }),
      makeJob("b", { name: "welcome-email-retry" }),
      makeJob("c", { name: "welcome-email" }),
    ];
    mockState.totalFailedCount = 3;

    const result = await retryFailedJobs("q", { name: "welcome-email", dryRun: true });

    expect(result.matched).toBe(2);
    expect(result.sampleJobIds).toEqual(["a", "c"]);
  });

  it("combines --since and --name (AND semantics)", async () => {
    const now = Date.now();
    mockState.failedJobs = [
      makeJob("a", { name: "x", finishedOn: now - 10 * 60 * 1000 }), // matches both
      makeJob("b", { name: "x", finishedOn: now - 2 * 60 * 60 * 1000 }), // wrong time
      makeJob("c", { name: "y", finishedOn: now - 10 * 60 * 1000 }), // wrong name
    ];
    mockState.totalFailedCount = 3;

    const result = await retryFailedJobs("q", { since: "1h", name: "x", dryRun: true });

    expect(result.matched).toBe(1);
    expect(result.sampleJobIds).toEqual(["a"]);
  });
});

describe("retryFailedJobs — live branch", () => {
  it("calls retry('failed') on every matched job and counts retried", async () => {
    const calls: Array<{ id: string; state: string }> = [];
    mockState.failedJobs = [
      makeJob("a", {}, async (state) => {
        calls.push({ id: "a", state });
      }),
      makeJob("b", {}, async (state) => {
        calls.push({ id: "b", state });
      }),
    ];
    mockState.totalFailedCount = 2;

    const result = await retryFailedJobs("q", {});

    expect(calls).toEqual([
      { id: "a", state: "failed" },
      { id: "b", state: "failed" },
    ]);
    expect(result.retried).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it("collects per-job retry errors and continues (best-effort, never stops)", async () => {
    mockState.failedJobs = [
      makeJob("a"),
      makeJob("b", {}, async () => {
        throw new Error("ERR job not found");
      }),
      makeJob("c"),
    ];
    mockState.totalFailedCount = 3;

    const result = await retryFailedJobs("q", {});

    expect(result.matched).toBe(3);
    expect(result.retried).toBe(2);
    expect(result.errors).toEqual([{ jobId: "b", error: "ERR job not found" }]);
  });

  it("records jobId 'unknown' when a failing job has no id", async () => {
    mockState.failedJobs = [
      makeJob(undefined, {}, async () => {
        throw new Error("boom");
      }),
    ];
    mockState.totalFailedCount = 1;

    const result = await retryFailedJobs("q", {});

    expect(result.errors).toEqual([{ jobId: "unknown", error: "boom" }]);
  });
});

describe("retryFailedJobs — truncation flag", () => {
  it("truncated=true when totalFailed exceeds the fetch window", async () => {
    mockState.failedJobs = Array.from({ length: 5 }, (_, i) => makeJob(`j${i}`));
    mockState.totalFailedCount = 5000;

    const result = await retryFailedJobs("q", { pageSize: 5, dryRun: true });

    expect(result.truncated).toBe(true);
  });

  it("truncated=false when the fetch window covers all failed jobs", async () => {
    mockState.failedJobs = Array.from({ length: 3 }, (_, i) => makeJob(`j${i}`));
    mockState.totalFailedCount = 3;

    const result = await retryFailedJobs("q", { dryRun: true });

    expect(result.truncated).toBe(false);
  });
});

describe("retryFailedJobs — validation", () => {
  it("throws on invalid --since format", async () => {
    mockState.failedJobs = [];
    mockState.totalFailedCount = 0;

    await expect(retryFailedJobs("q", { since: "bogus" })).rejects.toThrow("Invalid --since value");
  });

  it("clamps pageSize above the max", async () => {
    // Fill enough jobs to confirm clamping happened — if clamping didn't work,
    // getFailed would receive end = 999999.
    let requestedEnd = -1;
    mock.module("./queues.js", () => ({
      getQueue: (_name: string) => ({
        getFailed: async (_start: number, end: number) => {
          requestedEnd = end;
          return [];
        },
        getJobCounts: async () => ({ failed: 0 }),
      }),
    }));

    // Re-import after remock. (bun:test hoists module mocks — this re-mock takes
    // effect for calls made after it registers.)
    const { retryFailedJobs: rf } = await import("./jobs.js");
    await rf("q", { pageSize: 1_000_000, dryRun: true });

    // End index is pageSize - 1, so 10000 - 1 = 9999 after the clamp.
    expect(requestedEnd).toBe(9999);
  });
});
