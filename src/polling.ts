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
 *   - Schedulers: full-set observation (up to ~1000). Mirror the full set
 *     into SQLite, then paginate from SQLite. The full-set mirror lets
 *     SQLite pagination match Redis exactly.
 *
 * On disconnect, both render from SQLite via the disconnected fallback.
 */
import { getConfig } from "./config.js";
import { getAllQueueStats, type QueueStats } from "./data/queues.js";
import {
  getJobs,
  getJobsFromStore,
  type JobListView,
  type JobsResult,
  type JobSummary,
} from "./data/jobs.js";
import { getAllJobSchedulers, type JobSchedulerSummary } from "./data/schedulers.js";
import {
  calculateGlobalMetricsFromQueueStats,
  resetMetricsTracker,
  updateMetricsTracker,
} from "./data/metrics.js";
import { stateManager, type AppState } from "./state.js";
import {
  querySchedulers,
  queryQueueStats,
  upsertJobs,
  upsertQueueStats,
  upsertSchedulers,
} from "./data/sqlite.js";
import { markPolledWrites } from "./data/sync.js";

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

  start(): void {
    if (this.isRunning) return;

    const config = getConfig();
    this.isRunning = true;

    // Initial fetch
    this.poll();

    // Start polling interval
    this.intervalId = setInterval(() => {
      this.poll();
    }, config.pollInterval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  async poll(): Promise<void> {
    // Prevent concurrent polls
    if (this.isPolling) return;
    this.isPolling = true;

    const wasConnected = stateManager.getState().connected;

    try {
      stateManager.setState({ isLoading: true });

      // Observe queue stats from Redis, then read the TUI model from SQLite.
      // Redis is the writer/source of observations; the queue-data store is
      // the read path used to render state.
      const observedQueues = await getAllQueueStats();
      upsertQueueStats(observedQueues);
      const queues = queryQueueStats();
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

          const storeResult = querySchedulers(
            selectedQueue.name,
            currentState.schedulersPage,
            SCHEDULER_PAGE_SIZE,
          );

          stateManager.setState(schedulersViewState(storeResult.schedulers, observed.total));
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

      await this.applyDisconnectedFallback(errorMessage);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Serve last-known state from SQLite when the live Redis observation fails.
   * If the SQLite read itself fails, fall back to a minimal connected=false
   * state so the UI still shows the error banner.
   */
  private async applyDisconnectedFallback(errorMessage: string): Promise<void> {
    try {
      const queues = queryQueueStats();
      const currentState = stateManager.getState();
      const clampedIndex = clampQueueIndex(queues, currentState.selectedQueueIndex);
      const selectedQueue = queues[clampedIndex];

      let viewState: Partial<AppState>;
      if (selectedQueue && currentState.jobsStatus === "schedulers") {
        const storeResult = querySchedulers(
          selectedQueue.name,
          currentState.schedulersPage,
          SCHEDULER_PAGE_SIZE,
        );
        viewState = schedulersViewState(storeResult.schedulers, storeResult.total);
      } else if (selectedQueue) {
        const jobsResult = await getJobsFromStore(
          selectedQueue.name,
          currentState.jobsStatus,
          currentState.jobsPage,
        );
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
    return getJobs(queueName, status, page, undefined, true);
  }

  /**
   * Upsert observed jobs into SQLite and tell the background sync to leave
   * them alone for the next staging cycle. Best-effort: a SQLite failure
   * here must not break polling — the next cycle will retry.
   */
  private persistObservedJobs(queueName: string, jobs: JobSummary[]): void {
    try {
      upsertJobs(queueName, jobs);
      markPolledWrites(
        queueName,
        jobs.map((j) => j.id),
      );
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
   * We mirror the full set rather than a page so [[upsertSchedulers]]'s
   * replace semantics produce a SQLite cache that matches Redis —
   * pagination is then served from SQLite.
   */
  private async fetchAllSchedulers(
    queueName: string,
  ): Promise<{ schedulers: JobSchedulerSummary[]; total: number }> {
    const firstBatch = await getAllJobSchedulers(queueName);
    if (firstBatch.schedulers.length >= firstBatch.total) {
      return firstBatch;
    }
    return getAllJobSchedulers(queueName, firstBatch.total);
  }

  private persistObservedSchedulers(queueName: string, schedulers: JobSchedulerSummary[]): void {
    try {
      upsertSchedulers(queueName, schedulers);
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
        (await getJobsFromStore(selectedQueue.name, state.jobsStatus, state.jobsPage));

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

    const storeResult = querySchedulers(
      selectedQueue.name,
      state.schedulersPage,
      SCHEDULER_PAGE_SIZE,
    );
    const total = observed?.total ?? storeResult.total;

    stateManager.setState({
      schedulers: storeResult.schedulers,
      schedulersTotal: total,
      schedulersTotalPages: Math.ceil(total / SCHEDULER_PAGE_SIZE),
    });
  }
}

// Singleton
export const pollingManager = new PollingManager();
