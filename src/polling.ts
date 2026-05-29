/**
 * Polling: Redis observes, SQLite renders on disconnect.
 *
 * Jobs and schedulers use asymmetric strategies on the connected path,
 * justified by their data shapes:
 *
 *   - Jobs: page-only observation. Render directly from the observed page;
 *     also persist it so the disconnected fallback can serve last-known
 *     rows. SQLite can't be the connected render source because we only
 *     ever observe the current page — other pages aren't in the cache.
 *
 *   - Schedulers: full-set observation (up to ~1000). Render the connected
 *     view from that Redis observation, and persist it so disconnected
 *     fallback can serve last-known rows.
 *
 * On disconnect, both render from SQLite via the disconnected fallback.
 */
import type { Context } from "./context.js";
import { getAllQueueStats, type QueueStats } from "./data/queues.js";
import { getJobs, type JobListView, type JobsResult, type JobSummary } from "./data/jobs.js";
import { getAllJobSchedulers, type JobSchedulerSummary } from "./data/schedulers.js";
import {
  calculateGlobalMetricsFromQueueStats,
  resetMetricsTracker,
  updateMetricsTracker,
} from "./data/metrics.js";
import { stateManager, type AppState } from "./state.js";
import {
  listJobs,
  listQueues,
  listSchedulers,
  recordObservedJobs,
  recordObservedQueues,
  recordObservedSchedulers,
} from "./data/queue-store.js";
import { runQueueStoreCleanupIfDue } from "./data/queue-store-lifecycle.js";

const SCHEDULER_PAGE_SIZE = 25;

const ZERO_RATES = {
  enqueuedPerMin: 0,
  enqueuedPerSec: 0,
  dequeuedPerMin: 0,
  dequeuedPerSec: 0,
} as const;

function jobsViewState(result: JobsResult): Partial<AppState> {
  return {
    jobs: result.jobs,
    jobsTotal: result.total,
    jobsTotalPages: result.totalPages,
    schedulers: [],
    schedulersTotal: 0,
    schedulersTotalPages: 0,
  };
}

function schedulersViewState(schedulers: JobSchedulerSummary[], total: number): Partial<AppState> {
  return {
    schedulers,
    schedulersTotal: total,
    schedulersTotalPages: Math.ceil(total / SCHEDULER_PAGE_SIZE),
    jobs: [],
    jobsTotal: 0,
    jobsTotalPages: 0,
  };
}

function pageSchedulers(
  schedulers: JobSchedulerSummary[],
  page: number,
  pageSize: number = SCHEDULER_PAGE_SIZE,
): JobSchedulerSummary[] {
  const start = (page - 1) * pageSize;
  return schedulers.slice(start, start + pageSize);
}

const EMPTY_QUEUE_VIEW: Partial<AppState> = {
  jobs: [],
  jobsTotal: 0,
  jobsTotalPages: 0,
  schedulers: [],
  schedulersTotal: 0,
  schedulersTotalPages: 0,
};

function clampQueueIndex(queues: QueueStats[], currentIndex: number): number {
  return queues.length > 0 ? Math.min(currentIndex, queues.length - 1) : 0;
}

class PollingManager {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isPolling = false;
  private ctx: Context | null = null;

  /**
   * Single chokepoint for non-null ctx access from private methods. Throws
   * with a clear message if a refresh fires after `stop()` cleared ctx
   * (reachable via async key handlers in TUI mode).
   */
  private requireCtx(): Context {
    if (!this.ctx) {
      throw new Error("PollingManager.start(ctx) must be called before refresh*/poll");
    }
    return this.ctx;
  }

  start(ctx: Context): void {
    if (this.isRunning) return;

    this.ctx = ctx;
    this.isRunning = true;

    // Initial fetch
    this.poll();

    // Start polling interval
    this.intervalId = setInterval(() => {
      this.poll();
    }, ctx.config.pollInterval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    this.ctx = null;
  }

  async poll(): Promise<void> {
    // Prevent concurrent polls
    if (this.isPolling) return;
    // Bail silently if a poll tick fires after stop() — happens once on the
    // interval timer between stop() and the clearInterval taking effect.
    if (!this.ctx) return;
    this.isPolling = true;
    const ctx = this.ctx;

    const wasConnected = stateManager.getState().connected;

    try {
      stateManager.setState({ isLoading: true });

      // Observe queue stats from Redis, then read the TUI model from SQLite.
      // Redis is the writer/source of observations; the queue-data store is
      // the read path used to render state.
      const observedQueues = await getAllQueueStats(ctx);
      recordObservedQueues(ctx, observedQueues);
      const queues = listQueues(ctx);
      const rates = updateMetricsTracker(queues);
      const globalMetrics = calculateGlobalMetricsFromQueueStats(queues, rates);

      // Clamp selectedQueueIndex to valid range if queues changed
      const currentState = stateManager.getState();
      const clampedIndex = clampQueueIndex(queues, currentState.selectedQueueIndex);

      stateManager.setState({
        queues,
        globalMetrics,
        connected: true,
        error: null,
        selectedQueueIndex: clampedIndex,
      });

      // jobsStatus / jobsPage / schedulersPage weren't touched above, so
      // currentState is still authoritative for the view selection.
      const selectedQueue = queues[clampedIndex];
      if (selectedQueue) {
        // If status is "schedulers", fetch schedulers instead of jobs
        if (currentState.jobsStatus === "schedulers") {
          const observed = await this.fetchAllSchedulers(selectedQueue.name);
          this.persistObservedSchedulers(selectedQueue.name, observed.schedulers);

          stateManager.setState(
            schedulersViewState(
              pageSchedulers(observed.schedulers, currentState.schedulersPage),
              observed.total,
            ),
          );
        } else {
          const observedJobsResult = await this.fetchVisibleJobs(
            selectedQueue.name,
            currentState.jobsStatus,
            currentState.jobsPage,
          );
          this.persistObservedJobs(selectedQueue.name, observedJobsResult.jobs);

          stateManager.setState(jobsViewState(observedJobsResult));
        }
      } else {
        stateManager.setState(EMPTY_QUEUE_VIEW);
      }

      stateManager.setState({ isLoading: false });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Reset metrics tracker when disconnecting to avoid stale rate data on reconnect
      if (wasConnected) {
        resetMetricsTracker();
      }

      await this.applyDisconnectedFallback(ctx, errorMessage);
    } finally {
      runQueueStoreCleanupIfDue(ctx);
      this.isPolling = false;
    }
  }

  /**
   * Serve last-known state from SQLite when the live Redis observation fails.
   * If the SQLite read itself fails, fall back to a minimal connected=false
   * state so the UI still shows the error banner.
   *
   * Takes `ctx` as an argument (rather than reading `this.ctx`) so a `stop()`
   * that fires between `poll()`'s redis observation and the catch handler
   * can't surface as a confusing requireCtx error inside the disconnect
   * path. `poll()` captures the ctx reference once at the top, so the
   * cached connection is still valid here.
   */
  private async applyDisconnectedFallback(ctx: Context, errorMessage: string): Promise<void> {
    try {
      const queues = listQueues(ctx);
      const currentState = stateManager.getState();
      const clampedIndex = clampQueueIndex(queues, currentState.selectedQueueIndex);
      const selectedQueue = queues[clampedIndex];

      let viewState: Partial<AppState>;
      if (selectedQueue && currentState.jobsStatus === "schedulers") {
        const storeResult = listSchedulers(ctx, selectedQueue.name, {
          page: currentState.schedulersPage,
          pageSize: SCHEDULER_PAGE_SIZE,
        });
        viewState = schedulersViewState(storeResult.schedulers, storeResult.total);
      } else if (selectedQueue) {
        const jobsResult = listJobs(ctx, selectedQueue.name, {
          state: currentState.jobsStatus,
          page: currentState.jobsPage,
        });
        viewState = jobsViewState(jobsResult);
      } else {
        viewState = EMPTY_QUEUE_VIEW;
      }

      stateManager.setState({
        queues,
        selectedQueueIndex: clampedIndex,
        // Pass explicit zeroed rates: feeding the tracker stale SQLite stats
        // every error tick would let the previous-sample timestamp drift, and
        // the first successful reconnect would compute a rate against a stale
        // snapshot, producing a spurious spike until the next tick smooths it.
        globalMetrics: calculateGlobalMetricsFromQueueStats(queues, ZERO_RATES),
        connected: false,
        error: errorMessage,
        isLoading: false,
        ...viewState,
      });
    } catch (fallbackError) {
      // The cache itself failed during a disconnect — without this log, the
      // user only sees the original Redis error and operators have no signal
      // that the SQLite layer also broke.
      console.error(
        "Disconnect fallback failed:",
        fallbackError instanceof Error ? fallbackError.message : fallbackError,
      );
      stateManager.setState({
        connected: false,
        error: errorMessage,
        isLoading: false,
      });
    }
  }

  /**
   * Fetch a page of visible jobs from Redis. Read-only — see
   * [[persistObservedJobs]] for the SQLite write step.
   */
  private async fetchVisibleJobs(
    queueName: string,
    status: JobListView,
    page: number,
  ): Promise<JobsResult> {
    return getJobs(this.requireCtx(), queueName, status, page, undefined, true);
  }

  /**
   * Upsert observed jobs into SQLite. Best-effort: a SQLite failure here must
   * not break polling — the next cycle will retry.
   */
  private persistObservedJobs(queueName: string, jobs: JobSummary[]): void {
    const ctx = this.requireCtx();
    try {
      recordObservedJobs(ctx, queueName, jobs);
    } catch (error) {
      // SQLite upsert is best-effort; don't break polling on failure. But
      // warn so disk-full / schema-corrupt scenarios don't masquerade as
      // silently stale disconnect fallbacks.
      console.warn(
        `Failed to persist observed jobs for "${queueName}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Fetch every scheduler for a queue.
   *
   * Common case (total ≤ 1000): one round-trip via [[getAllJobSchedulers]]'s
   * parallel count+fetch. Rare case (total > 1000): the first 1000-item
   * batch is discarded and a second call refetches sized to the observed
   * total. The wastage is bounded; we keep the parallel fast-path rather
   * than always doing a sequential count-then-fetch that would cost an
   * extra round-trip in the common case.
   *
   * We fetch the full set so connected rendering can page over the current
   * Redis observation. The queue-store observation is still recorded for
   * disconnected fallback, but it is TTL-based and may include stale rows.
   */
  private async fetchAllSchedulers(
    queueName: string,
  ): Promise<{ schedulers: JobSchedulerSummary[]; total: number }> {
    const firstBatch = await getAllJobSchedulers(this.requireCtx(), queueName);
    if (firstBatch.schedulers.length >= firstBatch.total) {
      return firstBatch;
    }
    return getAllJobSchedulers(this.requireCtx(), queueName, firstBatch.total);
  }

  private persistObservedSchedulers(queueName: string, schedulers: JobSchedulerSummary[]): void {
    try {
      recordObservedSchedulers(this.requireCtx(), queueName, schedulers);
    } catch (error) {
      // Best-effort, same as persistObservedJobs — warn for visibility.
      console.warn(
        `Failed to persist observed schedulers for "${queueName}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Manual refresh - full poll
  async refresh(): Promise<void> {
    await this.poll();
  }

  // Light refresh - only fetch jobs/schedulers for current queue (fast)
  async refreshJobs(): Promise<void> {
    const state = stateManager.getState();
    const selectedQueue = state.queues[state.selectedQueueIndex];

    if (!selectedQueue) {
      stateManager.setState(EMPTY_QUEUE_VIEW);
      return;
    }

    try {
      // If status is "schedulers", fetch schedulers instead of jobs
      if (state.jobsStatus === "schedulers") {
        await this.refreshSchedulers();
        return;
      }

      let observedJobsResult: JobsResult | null = null;
      try {
        observedJobsResult = await this.fetchVisibleJobs(
          selectedQueue.name,
          state.jobsStatus,
          state.jobsPage,
        );
        this.persistObservedJobs(selectedQueue.name, observedJobsResult.jobs);
      } catch (error) {
        console.error("Failed to observe jobs:", error instanceof Error ? error.message : error);
      }

      const jobsResult =
        observedJobsResult ??
        listJobs(this.requireCtx(), selectedQueue.name, {
          state: state.jobsStatus,
          page: state.jobsPage,
        });

      stateManager.setState({
        jobs: jobsResult.jobs,
        jobsTotal: jobsResult.total,
        jobsTotalPages: jobsResult.totalPages,
      });
    } catch (error) {
      // Don't disconnect on job refresh failure, but log the error for debugging
      console.error("Failed to refresh jobs:", error instanceof Error ? error.message : error);
    }
  }

  // Refresh schedulers specifically
  async refreshSchedulers(): Promise<void> {
    const state = stateManager.getState();
    const selectedQueue = state.queues[state.selectedQueueIndex];

    if (!selectedQueue) {
      stateManager.setState({
        schedulers: [],
        schedulersTotal: 0,
        schedulersTotalPages: 0,
      });
      return;
    }

    let observed: { schedulers: JobSchedulerSummary[]; total: number } | null = null;
    try {
      observed = await this.fetchAllSchedulers(selectedQueue.name);
      this.persistObservedSchedulers(selectedQueue.name, observed.schedulers);
    } catch (error) {
      console.error(
        "Failed to refresh schedulers:",
        error instanceof Error ? error.message : error,
      );
    }

    if (observed) {
      stateManager.setState({
        schedulers: pageSchedulers(observed.schedulers, state.schedulersPage),
        schedulersTotal: observed.total,
        schedulersTotalPages: Math.ceil(observed.total / SCHEDULER_PAGE_SIZE),
      });
      return;
    }

    const storeResult = listSchedulers(this.requireCtx(), selectedQueue.name, {
      page: state.schedulersPage,
      pageSize: SCHEDULER_PAGE_SIZE,
    });

    stateManager.setState({
      schedulers: storeResult.schedulers,
      schedulersTotal: storeResult.total,
      schedulersTotalPages: Math.ceil(storeResult.total / SCHEDULER_PAGE_SIZE),
    });
  }
}

// Singleton
export const pollingManager = new PollingManager();
