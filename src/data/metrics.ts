import type { QueueStats } from "./queues.js";

export interface GlobalMetrics {
  queueCount: number;
  jobCounts: {
    wait: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    total: number;
  };
  rates: {
    enqueuedPerMin: number; // jobs added per minute
    enqueuedPerSec: number; // jobs added per second
    dequeuedPerMin: number; // jobs processed per minute
    dequeuedPerSec: number; // jobs processed per second
  };
}

/**
 * Tracks job counts between polls to calculate enqueue/dequeue rates
 */
class MetricsTracker {
  private lastPollTime: number | null = null;
  private lastTotalJobs: number = 0; // all jobs that entered the system
  private lastProcessedJobs: number = 0; // completed + failed

  // Smoothed rates (using exponential moving average)
  private smoothedEnqueuedPerMin: number = 0;
  private smoothedDequeuedPerMin: number = 0;
  private readonly smoothingFactor = 0.3; // Higher = more responsive, lower = smoother

  /**
   * Update tracker with current counts and return calculated rates
   */
  update(jobCounts: GlobalMetrics["jobCounts"]): GlobalMetrics["rates"] {
    const now = Date.now();

    // Total jobs = all jobs that have ever entered the system
    // (wait + active + delayed + completed + failed)
    const currentTotalJobs =
      jobCounts.wait +
      jobCounts.active +
      jobCounts.delayed +
      jobCounts.completed +
      jobCounts.failed;

    // Processed jobs = jobs that have been dequeued and finished
    const currentProcessedJobs = jobCounts.completed + jobCounts.failed;

    // First poll - no previous data to compare
    if (this.lastPollTime === null) {
      this.lastPollTime = now;
      this.lastTotalJobs = currentTotalJobs;
      this.lastProcessedJobs = currentProcessedJobs;

      return {
        enqueuedPerMin: 0,
        enqueuedPerSec: 0,
        dequeuedPerMin: 0,
        dequeuedPerSec: 0,
      };
    }

    // Calculate time elapsed in minutes
    const elapsedMs = now - this.lastPollTime;
    const elapsedMin = elapsedMs / 60000;

    // Avoid division by zero for very short intervals
    if (elapsedMin < 0.001) {
      return {
        enqueuedPerMin: this.smoothedEnqueuedPerMin,
        enqueuedPerSec: this.smoothedEnqueuedPerMin / 60,
        dequeuedPerMin: this.smoothedDequeuedPerMin,
        dequeuedPerSec: this.smoothedDequeuedPerMin / 60,
      };
    }

    // Calculate deltas (clamp to 0 if negative due to job deletions)
    const jobsEnqueued = Math.max(0, currentTotalJobs - this.lastTotalJobs);
    const jobsDequeued = Math.max(0, currentProcessedJobs - this.lastProcessedJobs);

    // Calculate instantaneous rates (per minute)
    const instantEnqueuedPerMin = jobsEnqueued / elapsedMin;
    const instantDequeuedPerMin = jobsDequeued / elapsedMin;

    // Apply exponential moving average for smoother display
    this.smoothedEnqueuedPerMin =
      this.smoothingFactor * instantEnqueuedPerMin +
      (1 - this.smoothingFactor) * this.smoothedEnqueuedPerMin;

    this.smoothedDequeuedPerMin =
      this.smoothingFactor * instantDequeuedPerMin +
      (1 - this.smoothingFactor) * this.smoothedDequeuedPerMin;

    // Update state for next poll
    this.lastPollTime = now;
    this.lastTotalJobs = currentTotalJobs;
    this.lastProcessedJobs = currentProcessedJobs;

    return {
      enqueuedPerMin: parseFloat(this.smoothedEnqueuedPerMin.toFixed(1)),
      enqueuedPerSec: parseFloat((this.smoothedEnqueuedPerMin / 60).toFixed(2)),
      dequeuedPerMin: parseFloat(this.smoothedDequeuedPerMin.toFixed(1)),
      dequeuedPerSec: parseFloat((this.smoothedDequeuedPerMin / 60).toFixed(2)),
    };
  }

  /**
   * Reset tracker state (useful for testing or manual reset)
   */
  reset(): void {
    this.lastPollTime = null;
    this.lastTotalJobs = 0;
    this.lastProcessedJobs = 0;
    this.smoothedEnqueuedPerMin = 0;
    this.smoothedDequeuedPerMin = 0;
  }
}

// Singleton tracker instance
const metricsTracker = new MetricsTracker();

/**
 * Reset the metrics tracker (call when reconnecting or resetting state)
 */
export function resetMetricsTracker(): void {
  metricsTracker.reset();
}

function aggregateJobCounts(queues: QueueStats[]): GlobalMetrics["jobCounts"] {
  const jobCounts: GlobalMetrics["jobCounts"] = {
    wait: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    total: 0,
  };
  for (const { counts } of queues) {
    jobCounts.wait += counts.wait;
    jobCounts.active += counts.active;
    jobCounts.completed += counts.completed;
    jobCounts.failed += counts.failed;
    jobCounts.delayed += counts.delayed;
    jobCounts.total +=
      counts.wait + counts.active + counts.completed + counts.failed + counts.delayed;
  }
  return jobCounts;
}

/**
 * Pure aggregation: no tracker mutation. Callers feed `rates` explicitly —
 * either fresh from [[updateMetricsTracker]] on the success path, or zeroed
 * on the disconnected path.
 */
export function calculateGlobalMetricsFromQueueStats(
  queues: QueueStats[],
  rates: GlobalMetrics["rates"],
): GlobalMetrics {
  return {
    queueCount: queues.length,
    jobCounts: aggregateJobCounts(queues),
    rates,
  };
}

/**
 * Feed the singleton tracker with current counts and return the new rates.
 * Mutates tracker state — call exactly once per successful poll cycle.
 */
export function updateMetricsTracker(queues: QueueStats[]): GlobalMetrics["rates"] {
  return metricsTracker.update(aggregateJobCounts(queues));
}
