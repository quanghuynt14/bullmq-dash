import { getConfig } from "./config.js";
import { getAllQueueStats } from "./data/queues.js";
import { getJobs, getJobsFromStore, type JobListView } from "./data/jobs.js";
import { getJobSchedulers } from "./data/schedulers.js";
import {
  calculateGlobalMetricsFromQueueStats,
  resetMetricsTracker,
  updateMetricsTracker,
} from "./data/metrics.js";
import { stateManager } from "./state.js";
import { queryQueueStats, upsertJobs, upsertQueueStats } from "./data/sqlite.js";
import { markPolledWrites } from "./data/sync.js";

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
      const clampedIndex =
        queues.length > 0 ? Math.min(currentState.selectedQueueIndex, queues.length - 1) : 0;

      stateManager.setState({
        queues,
        globalMetrics,
        connected: true,
        error: null,
        selectedQueueIndex: clampedIndex,
      });

      // Re-read state after update to get current jobsStatus and jobsPage
      const updatedState = stateManager.getState();
      const selectedQueue = queues[clampedIndex];
      if (selectedQueue) {
        // If status is "schedulers", fetch schedulers instead of jobs
        if (updatedState.jobsStatus === "schedulers") {
          const schedulersResult = await getJobSchedulers(
            selectedQueue.name,
            updatedState.schedulersPage,
          );

          stateManager.setState({
            schedulers: schedulersResult.schedulers,
            schedulersTotal: schedulersResult.total,
            schedulersTotalPages: schedulersResult.totalPages,
            // Clear jobs when viewing schedulers
            jobs: [],
            jobsTotal: 0,
            jobsTotalPages: 0,
          });
        } else {
          await this.observeVisibleJobs(
            selectedQueue.name,
            updatedState.jobsStatus,
            updatedState.jobsPage,
          );

          const jobsResult = await getJobsFromStore(
            selectedQueue.name,
            updatedState.jobsStatus,
            updatedState.jobsPage,
          );

          stateManager.setState({
            jobs: jobsResult.jobs,
            jobsTotal: jobsResult.total,
            jobsTotalPages: jobsResult.totalPages,
            // Clear schedulers when viewing jobs
            schedulers: [],
            schedulersTotal: 0,
            schedulersTotalPages: 0,
          });
        }
      } else {
        stateManager.setState({
          jobs: [],
          jobsTotal: 0,
          jobsTotalPages: 0,
          schedulers: [],
          schedulersTotal: 0,
          schedulersTotalPages: 0,
        });
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
      const clampedIndex =
        queues.length > 0 ? Math.min(currentState.selectedQueueIndex, queues.length - 1) : 0;
      const selectedQueue = queues[clampedIndex];

      const fallbackState: Parameters<typeof stateManager.setState>[0] = {
        queues,
        selectedQueueIndex: clampedIndex,
        // Pass explicit zeroed rates: feeding the tracker stale SQLite stats
        // every error tick would let the previous-sample timestamp drift, and
        // the first successful reconnect would compute a rate against a stale
        // snapshot, producing a spurious spike until the next tick smooths it.
        globalMetrics: calculateGlobalMetricsFromQueueStats(queues, {
          enqueuedPerMin: 0,
          enqueuedPerSec: 0,
          dequeuedPerMin: 0,
          dequeuedPerSec: 0,
        }),
        connected: false,
        error: errorMessage,
        isLoading: false,
        // Schedulers are not persisted in SQLite yet, so don't show stale
        // scheduler rows while disconnected.
        schedulers: [],
        schedulersTotal: 0,
        schedulersTotalPages: 0,
      };

      if (selectedQueue && currentState.jobsStatus !== "schedulers") {
        const jobsResult = await getJobsFromStore(
          selectedQueue.name,
          currentState.jobsStatus,
          currentState.jobsPage,
        );
        fallbackState.jobs = jobsResult.jobs;
        fallbackState.jobsTotal = jobsResult.total;
        fallbackState.jobsTotalPages = jobsResult.totalPages;
      } else {
        fallbackState.jobs = [];
        fallbackState.jobsTotal = 0;
        fallbackState.jobsTotalPages = 0;
      }

      stateManager.setState(fallbackState);
    } catch {
      stateManager.setState({
        connected: false,
        error: errorMessage,
        isLoading: false,
      });
    }
  }

  private async observeVisibleJobs(
    queueName: string,
    status: JobListView,
    page: number,
  ): Promise<void> {
    const observedJobs = await getJobs(queueName, status, page, undefined, true);

    // Upsert fetched jobs into SQLite (best-effort, non-blocking).
    // markPolledWrites tells the background sync not to overwrite this
    // fresh state with a stale staging snapshot.
    try {
      upsertJobs(queueName, observedJobs.jobs);
      markPolledWrites(
        queueName,
        observedJobs.jobs.map((j) => j.id),
      );
    } catch {
      // SQLite upsert is best-effort; don't break polling on failure
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
      stateManager.setState({
        jobs: [],
        jobsTotal: 0,
        jobsTotalPages: 0,
        schedulers: [],
        schedulersTotal: 0,
        schedulersTotalPages: 0,
      });
      return;
    }

    try {
      // If status is "schedulers", fetch schedulers instead of jobs
      if (state.jobsStatus === "schedulers") {
        const schedulersResult = await getJobSchedulers(selectedQueue.name, state.schedulersPage);

        stateManager.setState({
          schedulers: schedulersResult.schedulers,
          schedulersTotal: schedulersResult.total,
          schedulersTotalPages: schedulersResult.totalPages,
        });
      } else {
        try {
          await this.observeVisibleJobs(selectedQueue.name, state.jobsStatus, state.jobsPage);
        } catch (error) {
          console.error("Failed to observe jobs:", error instanceof Error ? error.message : error);
        }

        const jobsResult = await getJobsFromStore(
          selectedQueue.name,
          state.jobsStatus,
          state.jobsPage,
        );

        stateManager.setState({
          jobs: jobsResult.jobs,
          jobsTotal: jobsResult.total,
          jobsTotalPages: jobsResult.totalPages,
        });
      }
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

    try {
      const schedulersResult = await getJobSchedulers(selectedQueue.name, state.schedulersPage);

      stateManager.setState({
        schedulers: schedulersResult.schedulers,
        schedulersTotal: schedulersResult.total,
        schedulersTotalPages: schedulersResult.totalPages,
      });
    } catch (error) {
      console.error(
        "Failed to refresh schedulers:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

// Singleton
export const pollingManager = new PollingManager();
