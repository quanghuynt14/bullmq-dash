import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { stateManager, type AppState } from "./state.js";
import { pollingManager } from "./polling.js";
import { getJobDetail, deleteJob, type JobListView } from "./data/jobs.js";
import type { QueueSortBy } from "./data/queue-sort.js";
import { getJobSchedulerDetail } from "./data/schedulers.js";
import { closeContext, type Context } from "./context.js";

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
import { createPageJump, updatePageJump, type PageJumpElements } from "./ui/page-jump.js";
import {
  clampPaletteIndex,
  createCommandPalette,
  filterPaletteActions,
  updateCommandPalette,
  type CommandPaletteElements,
  type PaletteAction,
} from "./ui/command-palette.js";

/** A palette entry plus the closure that executes it. */
interface RunnablePaletteAction extends PaletteAction {
  run: () => void | Promise<void>;
}

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
  commandPalette: CommandPaletteElements;
}

export class App {
  private renderer: CliRenderer | null = null;
  private elements: AppElements | null = null;
  private unsubscribeState: (() => void) | null = null;

  constructor(private readonly ctx: Context) {}

  private requireCtx(): Context {
    return this.ctx;
  }

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

    const ctx = this.ctx;

    // Explicit eager connect — matches `runJsonMode`'s startup shape so both
    // entry points agree on "the connection is opened on startup, not lazily
    // on the first BullMQ call." TUI swallows failures (the disconnect banner
    // surfaces them via the next poll cycle); headless exits 3.
    try {
      await ctx.redis.connect();
    } catch (error) {
      console.error(
        "Redis connection failed at startup:",
        error instanceof Error ? error.message : error,
      );
    }

    // Start polling. The poll loop runs queue-store TTL cleanup in its
    // `finally` block on every tick (rate-limited inside the helper), so no
    // separate cleanup timer is needed.
    pollingManager.start(ctx);

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
    const commandPalette = createCommandPalette(this.renderer);

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
      commandPalette,
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

    // Ctrl+C always quits. Bare `q` only quits outside text-input modes —
    // otherwise typing a queue name containing "q" would exit the app.
    if (key.ctrl && key.name === "c") {
      await this.cleanup();
      return;
    }
    if (key.name === "q" && !state.queueSearchActive && !state.showCommandPalette) {
      await this.cleanup();
      return;
    }

    // Command palette input mode
    if (state.showCommandPalette) {
      const available = filterPaletteActions(this.buildPaletteActions(state), state.paletteQuery);
      if (key.name === "escape") {
        stateManager.closeCommandPalette();
      } else if (key.name === "return" || key.name === "enter") {
        const action = available[clampPaletteIndex(state.paletteIndex, available.length)];
        stateManager.closeCommandPalette();
        if (action && available.length > 0) {
          await action.run();
        }
      } else if (key.name === "up") {
        stateManager.movePaletteSelection(-1, available.length);
      } else if (key.name === "down") {
        stateManager.movePaletteSelection(1, available.length);
      } else if (key.name === "backspace") {
        stateManager.setPaletteQuery(state.paletteQuery.slice(0, -1));
      } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        if (key.sequence >= " ") {
          stateManager.setPaletteQuery(state.paletteQuery + key.sequence);
        }
      }
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

    // Queue search input mode: all printable keys type into the filter.
    // The queue select is blurred while this is active (see render), so
    // typing 'j'/'k' can't move the selection underneath the input.
    if (state.queueSearchActive) {
      const selectedBefore = stateManager.getSelectedQueue()?.name;
      if (key.name === "escape") {
        stateManager.closeQueueSearch(false);
      } else if (key.name === "return" || key.name === "enter") {
        stateManager.closeQueueSearch(true);
      } else if (key.name === "backspace") {
        stateManager.backspaceQueueFilter();
      } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        // Printable characters only — control chars have sequences < " ".
        if (key.sequence >= " ") {
          stateManager.appendQueueFilter(key.sequence);
        }
      }
      // Filtering may have landed the selection on a different queue.
      if (stateManager.getSelectedQueue()?.name !== selectedBefore) {
        await pollingManager.refreshJobs();
      }
      return;
    }

    // Open queue search ('/' has no key.name; match the raw sequence)
    if (key.sequence === "/" && !key.ctrl && !key.meta) {
      stateManager.openQueueSearch();
      return;
    }

    // Open command palette
    if (key.ctrl && key.name === "p") {
      stateManager.openCommandPalette();
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
        if (
          state.focusedPane === "jobs" &&
          state.jobsStatus !== "schedulers" &&
          state.jobs.length > 0
        ) {
          stateManager.showDeleteConfirm();
        }
        break;

      case "r":
        await pollingManager.refresh();
        break;

      case "s":
        if (state.focusedPane === "queues") {
          stateManager.cycleQueueSort();
          await pollingManager.refresh();
        }
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
          await this.applyJobsStatus(newStatus);
        }
        break;
    }
  }

  private async applyJobsStatus(newStatus: JobListView): Promise<void> {
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

  /**
   * The command-palette action registry. Rebuilt per keystroke/render from
   * live state so titles and availability stay current (e.g. "Clear queue
   * filter" only exists while a filter is set).
   */
  private buildPaletteActions(state: AppState): RunnablePaletteAction[] {
    const actions: RunnablePaletteAction[] = [
      { id: "refresh", title: "Refresh data now", hint: "r", run: () => pollingManager.refresh() },
      {
        id: "search-queues",
        title: "Search queues",
        hint: "/",
        run: () => stateManager.openQueueSearch(),
      },
    ];

    if (state.queueFilter) {
      actions.push({
        id: "clear-queue-filter",
        title: `Clear queue filter /${state.queueFilter}`,
        run: async () => {
          stateManager.setQueueFilter("");
          await pollingManager.refreshJobs();
        },
      });
    }

    const sorts: Array<{ sortBy: QueueSortBy; title: string }> = [
      { sortBy: "task-size", title: "Sort queues by task size" },
      { sortBy: "failed", title: "Sort queues by failed jobs" },
      { sortBy: "waiting", title: "Sort queues by waiting jobs" },
      { sortBy: "name", title: "Sort queues by name" },
    ];
    for (const sort of sorts) {
      actions.push({
        id: `sort-${sort.sortBy}`,
        title: sort.title,
        hint: "s",
        run: async () => {
          stateManager.setQueueSort(sort.sortBy);
          await pollingManager.refresh();
        },
      });
    }

    const statuses: Array<{ status: JobListView; title: string; hint: string }> = [
      { status: "latest", title: "Show latest jobs", hint: "1" },
      { status: "wait", title: "Show waiting jobs", hint: "2" },
      { status: "active", title: "Show active jobs", hint: "3" },
      { status: "completed", title: "Show completed jobs", hint: "4" },
      { status: "failed", title: "Show failed jobs", hint: "5" },
      { status: "delayed", title: "Show delayed jobs", hint: "6" },
      { status: "schedulers", title: "Show schedulers", hint: "7" },
    ];
    for (const entry of statuses) {
      actions.push({
        id: `status-${entry.status}`,
        title: entry.title,
        hint: entry.hint,
        run: () => this.applyJobsStatus(entry.status),
      });
    }

    actions.push({
      id: "toggle-pane",
      title: "Switch pane",
      hint: "Tab",
      run: () => stateManager.toggleFocus(),
    });

    if (
      state.focusedPane === "jobs" &&
      state.jobsStatus !== "schedulers" &&
      state.jobs.length > 0
    ) {
      actions.push({
        id: "delete-job",
        title: "Delete selected job",
        hint: "d",
        run: () => stateManager.showDeleteConfirm(),
      });
    }

    actions.push({ id: "quit", title: "Quit bullmq-dash", hint: "q", run: () => this.cleanup() });
    return actions;
  }

  private async openJobDetail(): Promise<void> {
    const selectedJob = stateManager.getSelectedJob();
    const selectedQueue = stateManager.getSelectedQueue();

    if (!selectedJob || !selectedQueue) return;

    try {
      const detail = await getJobDetail(this.requireCtx(), selectedQueue.name, selectedJob.id);
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
      const detail = await getJobSchedulerDetail(
        this.requireCtx(),
        selectedQueue.name,
        selectedScheduler.key,
      );
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
      const jobDetail = await getJobDetail(
        this.requireCtx(),
        selectedQueue.name,
        schedulerDetail.nextJob.id,
      );
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
      await deleteJob(this.requireCtx(), selectedQueue.name, jobId);
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
      commandPalette,
    } = this.elements;

    const headerConfig = this.ctx.config;
    updateHeaderStatus(
      layout.headerStatus,
      state.connected,
      state.error,
      headerConfig.redis.host,
      headerConfig.redis.port,
    );

    // Update global metrics
    updateGlobalMetrics(globalMetrics, state.globalMetrics);

    // Update queue list. While the `/` search or command palette input is
    // active the select is deliberately unfocused so typed characters don't
    // double as navigation.
    updateQueueList(
      queueList,
      state.queues,
      state.selectedQueueIndex,
      state.focusedPane === "queues" && !state.queueSearchActive && !state.showCommandPalette,
      state.queueSortBy,
      state.queueSortOrder,
      state.queueFilter,
      state.queueSearchActive,
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
        state.focusedPane === "jobs" && !state.showCommandPalette,
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
        state.focusedPane === "jobs" && !state.showCommandPalette,
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

    // Update command palette
    const paletteActions = state.showCommandPalette
      ? filterPaletteActions(this.buildPaletteActions(state), state.paletteQuery)
      : [];
    updateCommandPalette(
      commandPalette,
      state.showCommandPalette,
      state.paletteQuery,
      paletteActions,
      state.paletteIndex,
    );
  }

  private async cleanup(): Promise<void> {
    // Stop polling (which also stops queue-store TTL cleanup)
    pollingManager.stop();

    // Unsubscribe from state
    if (this.unsubscribeState) {
      this.unsubscribeState();
    }

    // Close connections owned by the Context.
    await closeContext(this.ctx);

    // Destroy renderer
    if (this.renderer) {
      this.renderer.destroy();
    }

    process.exit(0);
  }
}
