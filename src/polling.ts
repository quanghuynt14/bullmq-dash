import { getConfig } from "./config.js";
import { getAllQueueStats } from "./data/queues.js";
import { getJobs } from "./data/jobs.js";
import { getJobSchedulers } from "./data/schedulers.js";
import { getGlobalMetrics, resetMetricsTracker } from "./data/metrics.js";
import { stateManager } from "./state.js";

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

      // Fetch queue stats and global metrics in parallel
      const [queues, globalMetrics] = await Promise.all([getAllQueueStats(), getGlobalMetrics()]);

      // Clamp selectedQueueIndex to valid range if queues changed
      const currentState = stateManager.getState();
      const clampedIndex = queues.length > 0
        ? Math.min(currentState.selectedQueueIndex, queues.length - 1)
        : 0;

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
        // If status is "scheduled", fetch schedulers instead of jobs
        if (updatedState.jobsStatus === "scheduled") {
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
          const jobsResult = await getJobs(
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

      stateManager.setState({
        connected: false,
        error: errorMessage,
        isLoading: false,
      });
    } finally {
      this.isPolling = false;
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
      // If status is "scheduled", fetch schedulers instead of jobs
      if (state.jobsStatus === "scheduled") {
        const schedulersResult = await getJobSchedulers(
          selectedQueue.name,
          state.schedulersPage,
        );

        stateManager.setState({
          schedulers: schedulersResult.schedulers,
          schedulersTotal: schedulersResult.total,
          schedulersTotalPages: schedulersResult.totalPages,
        });
      } else {
        const jobsResult = await getJobs(selectedQueue.name, state.jobsStatus, state.jobsPage);

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
      const schedulersResult = await getJobSchedulers(
        selectedQueue.name,
        state.schedulersPage,
      );

      stateManager.setState({
        schedulers: schedulersResult.schedulers,
        schedulersTotal: schedulersResult.total,
        schedulersTotalPages: schedulersResult.totalPages,
      });
    } catch (error) {
      console.error("Failed to refresh schedulers:", error instanceof Error ? error.message : error);
    }
  }
}

// Singleton
export const pollingManager = new PollingManager();
