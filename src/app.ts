import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { stateManager } from "./state.js";
import { pollingManager } from "./polling.js";
import { getJobDetail, deleteJob } from "./data/jobs.js";
import { getJobSchedulerDetail } from "./data/schedulers.js";
import { disconnectRedis } from "./data/redis.js";
import { closeAllQueues } from "./data/queues.js";
import { getConfig } from "./config.js";

// UI imports
import { createLayout, updateHeaderStatus, type LayoutElements } from "./ui/layout.js";
import { createQueueList, updateQueueList, type QueueListElements } from "./ui/queue-list.js";
import { createQueueStats, updateQueueStats, type QueueStatsElements } from "./ui/queue-stats.js";
import {
  createStatusFilter,
  updateStatusFilter,
  getStatusFromKey,
  type StatusFilterElements,
} from "./ui/status-filter.js";
import { createJobList, updateJobList, type JobListElements } from "./ui/job-list.js";
import { createJobDetail, updateJobDetail, type JobDetailElements } from "./ui/job-detail.js";
import {
  createSchedulerList,
  updateSchedulerList,
  showSchedulerList,
  hideSchedulerList,
  type SchedulerListElements,
} from "./ui/scheduler-list.js";
import {
  createSchedulerDetail,
  updateSchedulerDetail,
  type SchedulerDetailElements,
} from "./ui/scheduler-detail.js";
import {
  createConfirmDialog,
  showConfirmDialog,
  hideConfirmDialog,
  type ConfirmDialogElements,
} from "./ui/confirm-dialog.js";
import {
  createGlobalMetrics,
  updateGlobalMetrics,
  type GlobalMetricsElements,
} from "./ui/global-metrics.js";
import {
  createPageJump,
  updatePageJump,
  type PageJumpElements,
} from "./ui/page-jump.js";

interface AppElements {
  layout: LayoutElements;
  globalMetrics: GlobalMetricsElements;
  queueList: QueueListElements;
  queueStats: QueueStatsElements;
  statusFilter: StatusFilterElements;
  jobList: JobListElements;
  jobDetail: JobDetailElements;
  schedulerList: SchedulerListElements;
  schedulerDetail: SchedulerDetailElements;
  confirmDialog: ConfirmDialogElements;
  pageJump: PageJumpElements;
}

export class App {
  private renderer: CliRenderer | null = null;
  private elements: AppElements | null = null;
  private unsubscribeState: (() => void) | null = null;

  async start(): Promise<void> {
    // Create renderer
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      targetFps: 30,
    });

    this.renderer.setBackgroundColor("#0f172a");

    // Create UI elements
    this.elements = this.createElements();

    // Setup keyboard handling
    this.setupKeyboardHandling();

    // Subscribe to state changes (triggers render on any state update)
    this.unsubscribeState = stateManager.subscribe(() => {
      this.render();
    });

    // Start polling
    pollingManager.start();

    // Initial render
    this.render();
  }

  private createElements(): AppElements {
    if (!this.renderer) throw new Error("Renderer not initialized");

    const layout = createLayout(this.renderer);
    const globalMetrics = createGlobalMetrics(this.renderer, layout.metricsBar);
    const queueList = createQueueList(this.renderer, layout.leftPane);
    const queueStats = createQueueStats(this.renderer, layout.rightPane);
    const statusFilter = createStatusFilter(this.renderer, layout.rightPane);
    const jobList = createJobList(this.renderer, layout.rightPane);
    const schedulerList = createSchedulerList(this.renderer, layout.rightPane);
    const jobDetail = createJobDetail(this.renderer);
    const schedulerDetail = createSchedulerDetail(this.renderer);
    const confirmDialog = createConfirmDialog(this.renderer);
    const pageJump = createPageJump(this.renderer);

    return {
      layout,
      globalMetrics,
      queueList,
      queueStats,
      statusFilter,
      jobList,
      jobDetail,
      schedulerList,
      schedulerDetail,
      confirmDialog,
      pageJump,
    };
  }

  private setupKeyboardHandling(): void {
    if (!this.renderer) return;

    this.renderer.keyInput.on("keypress", async (key: KeyEvent) => {
      try {
        await this.handleKeyPress(key);
      } catch (error) {
        console.error("Key handler error:", error instanceof Error ? error.message : error);
      }
    });
  }

  private async handleKeyPress(key: KeyEvent): Promise<void> {
    const state = stateManager.getState();

    // Global keys
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      await this.cleanup();
      return;
    }

    // Confirm dialog handling
    if (state.showConfirmDelete) {
      if (key.name === "y") {
        await this.confirmDelete();
      } else if (key.name === "n" || key.name === "escape") {
        stateManager.hideDeleteConfirm();
      }
      return;
    }

    // Page jump modal handling
    if (state.showPageJump) {
      if (key.name === "escape") {
        stateManager.hidePageJumpModal();
      } else if (key.name === "return" || key.name === "enter") {
        await this.confirmPageJump();
      } else if (key.name === "backspace") {
        stateManager.backspacePageJumpInput();
      } else if (key.sequence && /^\d$/.test(key.sequence)) {
        stateManager.appendPageJumpInput(key.sequence);
      }
      return;
    }

    // Job detail view handling
    if (state.showJobDetail) {
      if (key.name === "escape") {
        stateManager.closeJobDetail();
      } else if (key.name === "d") {
        stateManager.showDeleteConfirm();
      }
      return;
    }

    // Scheduler detail view handling
    if (state.showSchedulerDetail) {
      if (key.name === "escape") {
        stateManager.closeSchedulerDetail();
      } else if (key.name === "j") {
        // Navigate to the next delayed job detail
        await this.openSchedulerNextJob();
      }
      return;
    }

    // Navigation keys
    switch (key.name) {
      case "tab":
        stateManager.toggleFocus();
        break;

      // j/k and up/down are handled by SelectRenderable when the pane is focused
      // The SELECTION_CHANGED event updates our state

      case "return":
      case "enter":
        if (state.focusedPane === "jobs") {
          // If viewing schedulers, open scheduler detail
          if (state.jobsStatus === "schedulers") {
            await this.openSchedulerDetail();
          } else {
            await this.openJobDetail();
          }
        } else {
          // Select queue and switch to jobs pane
          stateManager.setState({ focusedPane: "jobs" });
        }
        break;

      case "left":
        if (state.focusedPane === "jobs") {
          if (state.jobsStatus === "schedulers") {
            stateManager.prevSchedulerPage();
            await pollingManager.refreshSchedulers();
          } else {
            stateManager.prevPage();
            await pollingManager.refreshJobs();
          }
        }
        break;

      case "right":
        if (state.focusedPane === "jobs") {
          if (state.jobsStatus === "schedulers") {
            stateManager.nextSchedulerPage();
            await pollingManager.refreshSchedulers();
          } else {
            stateManager.nextPage();
            await pollingManager.refreshJobs();
          }
        }
        break;

      case "d":
        // Delete only works for regular jobs, not schedulers
        if (state.focusedPane === "jobs" && state.jobsStatus !== "schedulers" && state.jobs.length > 0) {
          stateManager.showDeleteConfirm();
        }
        break;

      case "r":
        await pollingManager.refresh();
        break;

      case "g":
        // Open page jump modal when in jobs pane
        if (state.focusedPane === "jobs") {
          if (state.jobsStatus === "schedulers" && state.schedulersTotalPages > 1) {
            stateManager.showPageJumpModal();
          } else if (state.jobsStatus !== "schedulers" && state.jobsTotalPages > 1) {
            stateManager.showPageJumpModal();
          }
        }
        break;

      // Status filter shortcuts (1-7)
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
        const newStatus = getStatusFromKey(key.name);
        if (newStatus) {
          stateManager.setJobsStatus(newStatus);
          // Reset scheduler state when switching to schedulers
          if (newStatus === "schedulers") {
            stateManager.setState({
              selectedSchedulerIndex: 0,
              schedulersPage: 1,
            });
          }
          await pollingManager.refreshJobs();
        }
        break;
    }
  }

  private async openJobDetail(): Promise<void> {
    const selectedJob = stateManager.getSelectedJob();
    const selectedQueue = stateManager.getSelectedQueue();

    if (!selectedJob || !selectedQueue) return;

    try {
      const detail = await getJobDetail(selectedQueue.name, selectedJob.id);
      if (detail) {
        stateManager.openJobDetail(detail);
      }
    } catch {
      // Handle error silently for now
    }
  }

  private async openSchedulerDetail(): Promise<void> {
    const selectedScheduler = stateManager.getSelectedScheduler();
    const selectedQueue = stateManager.getSelectedQueue();

    if (!selectedScheduler || !selectedQueue) return;

    try {
      const detail = await getJobSchedulerDetail(selectedQueue.name, selectedScheduler.key);
      if (detail) {
        stateManager.openSchedulerDetail(detail);
      }
    } catch {
      // Handle error silently for now
    }
  }

  private async openSchedulerNextJob(): Promise<void> {
    const state = stateManager.getState();
    const schedulerDetail = state.schedulerDetail;
    const selectedQueue = stateManager.getSelectedQueue();

    if (!schedulerDetail?.nextJob || !selectedQueue) return;

    try {
      const jobDetail = await getJobDetail(selectedQueue.name, schedulerDetail.nextJob.id);
      if (jobDetail) {
        // Close scheduler detail and open job detail
        stateManager.closeSchedulerDetail();
        stateManager.openJobDetail(jobDetail);
      }
    } catch {
      // Handle error silently for now
    }
  }

  private async confirmDelete(): Promise<void> {
    const state = stateManager.getState();
    const selectedQueue = stateManager.getSelectedQueue();

    let jobId: string | undefined;

    if (state.showJobDetail && state.jobDetail) {
      jobId = state.jobDetail.id;
    } else {
      const selectedJob = stateManager.getSelectedJob();
      jobId = selectedJob?.id;
    }

    if (!selectedQueue || !jobId) {
      stateManager.hideDeleteConfirm();
      return;
    }

    try {
      await deleteJob(selectedQueue.name, jobId);
      stateManager.hideDeleteConfirm();
      stateManager.closeJobDetail();
      await pollingManager.refresh();
    } catch {
      stateManager.hideDeleteConfirm();
    }
  }

  private async confirmPageJump(): Promise<void> {
    const state = stateManager.getState();
    const pageInput = state.pageJumpInput;

    if (pageInput) {
      const targetPage = parseInt(pageInput, 10);
      if (!isNaN(targetPage) && targetPage >= 1) {
        if (state.jobsStatus === "schedulers") {
          stateManager.goToSchedulerPage(targetPage);
          await pollingManager.refreshSchedulers();
        } else {
          stateManager.goToPage(targetPage);
          await pollingManager.refreshJobs();
        }
      }
    }

    stateManager.hidePageJumpModal();
  }

  private render(): void {
    if (!this.elements) return;

    const state = stateManager.getState();
    const {
      layout,
      globalMetrics,
      queueList,
      queueStats,
      statusFilter,
      jobList,
      jobDetail,
      schedulerList,
      schedulerDetail,
      confirmDialog,
      pageJump,
    } = this.elements;

    // Update header
    const config = getConfig();
    updateHeaderStatus(
      layout.headerStatus,
      state.connected,
      state.error,
      config.redis.host,
      config.redis.port,
    );

    // Update global metrics
    updateGlobalMetrics(globalMetrics, state.globalMetrics);

    // Update queue list
    updateQueueList(
      queueList,
      state.queues,
      state.selectedQueueIndex,
      state.focusedPane === "queues",
    );

    // Update queue stats
    const selectedQueue = stateManager.getSelectedQueue();
    updateQueueStats(queueStats, selectedQueue);

    // Update status filter
    updateStatusFilter(statusFilter, state.jobsStatus);

    // Toggle between job list and scheduler list based on status
    const isSchedulersView = state.jobsStatus === "schedulers";

    if (isSchedulersView) {
      // Hide job list, show scheduler list
      jobList.container.visible = false;
      showSchedulerList(schedulerList);
      updateSchedulerList(
        schedulerList,
        state.schedulers,
        state.selectedSchedulerIndex,
        state.schedulersPage,
        state.schedulersTotalPages,
        state.schedulersTotal,
        state.focusedPane === "jobs",
      );
    } else {
      // Hide scheduler list, show job list
      hideSchedulerList(schedulerList);
      jobList.container.visible = true;
      updateJobList(
        jobList,
        state.jobs,
        state.selectedJobIndex,
        state.jobsPage,
        state.jobsTotalPages,
        state.jobsTotal,
        state.focusedPane === "jobs",
      );
    }

    // Update job detail
    updateJobDetail(jobDetail, state.jobDetail, state.showJobDetail);

    // Update scheduler detail
    updateSchedulerDetail(schedulerDetail, state.schedulerDetail, state.showSchedulerDetail);

    // Update confirm dialog
    if (state.showConfirmDelete) {
      const jobId = state.jobDetail?.id || stateManager.getSelectedJob()?.id || "unknown";
      showConfirmDialog(confirmDialog, jobId);
    } else {
      hideConfirmDialog(confirmDialog);
    }

    // Update page jump modal (handle both jobs and schedulers)
    updatePageJump(
      pageJump,
      state.showPageJump,
      state.pageJumpInput,
      isSchedulersView ? state.schedulersPage : state.jobsPage,
      isSchedulersView ? state.schedulersTotalPages : state.jobsTotalPages,
    );
  }

  private async cleanup(): Promise<void> {
    // Stop polling
    pollingManager.stop();

    // Unsubscribe from state
    if (this.unsubscribeState) {
      this.unsubscribeState();
    }

    // Close connections
    await closeAllQueues();
    await disconnectRedis();

    // Destroy renderer
    if (this.renderer) {
      this.renderer.destroy();
    }

    process.exit(0);
  }
}
