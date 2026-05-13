import { beforeEach, describe, expect, it } from "bun:test";
import {
  calculateGlobalMetricsFromQueueStats,
  resetMetricsTracker,
  updateMetricsTracker,
} from "./metrics.js";
import type { QueueStats } from "./queues.js";

const zeroRates = {
  enqueuedPerMin: 0,
  enqueuedPerSec: 0,
  dequeuedPerMin: 0,
  dequeuedPerSec: 0,
};

describe("calculateGlobalMetricsFromQueueStats", () => {
  it("aggregates observed queue stats without reaching Redis", () => {
    const metrics = calculateGlobalMetricsFromQueueStats(
      [
        {
          name: "email",
          counts: { wait: 2, active: 1, completed: 3, failed: 1, delayed: 4, schedulers: 0 },
          isPaused: false,
          total: 11,
        },
        {
          name: "payments",
          counts: { wait: 5, active: 2, completed: 7, failed: 0, delayed: 1, schedulers: 2 },
          isPaused: true,
          total: 15,
        },
      ],
      zeroRates,
    );

    expect(metrics).toEqual({
      queueCount: 2,
      jobCounts: {
        wait: 7,
        active: 3,
        completed: 10,
        failed: 1,
        delayed: 5,
        total: 26,
      },
      rates: zeroRates,
    });
  });

  it("returns zeroed jobCounts when no queues are observed", () => {
    const metrics = calculateGlobalMetricsFromQueueStats([], zeroRates);

    expect(metrics).toEqual({
      queueCount: 0,
      jobCounts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 },
      rates: zeroRates,
    });
  });
});

function buildQueue(counts: Partial<QueueStats["counts"]>): QueueStats {
  return {
    name: "q",
    counts: {
      wait: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      schedulers: 0,
      ...counts,
    },
    isPaused: false,
    total: 0,
  };
}

describe("updateMetricsTracker", () => {
  beforeEach(() => {
    resetMetricsTracker();
  });

  it("returns zeroed rates on the first call (no previous sample)", () => {
    expect(updateMetricsTracker([buildQueue({ wait: 5 })])).toEqual(zeroRates);
  });

  it("updates tracker state across calls", () => {
    updateMetricsTracker([buildQueue({ wait: 1 })]);
    // Second call has a previous sample to diff against; we don't assert on the
    // smoothed values (timing-dependent), only that the call doesn't throw and
    // returns the expected shape.
    const rates = updateMetricsTracker([buildQueue({ wait: 1, completed: 2 })]);
    expect(rates).toMatchObject({
      enqueuedPerMin: expect.any(Number),
      enqueuedPerSec: expect.any(Number),
      dequeuedPerMin: expect.any(Number),
      dequeuedPerSec: expect.any(Number),
    });
  });
});
