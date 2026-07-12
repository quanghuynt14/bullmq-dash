import type { QueueStats } from "./data/queues.js";
import {
  defaultSortOrder,
  sortQueues,
  type QueueSortBy,
  type SortOrder,
} from "./data/queue-sort.js";
import type { JobSummary, JobDetail, JobListView } from "./data/jobs.js";
import type { GlobalMetrics } from "./data/metrics.js";
import type { JobSchedulerSummary, JobSchedulerDetail } from "./data/schedulers.js";

export type FocusedPane = "queues" | "jobs";

const QUEUE_SORT_SEQUENCE: Array<{ sortBy: QueueSortBy; sortOrder: SortOrder }> = [
  { sortBy: "name", sortOrder: "asc" },
  { sortBy: "task-size", sortOrder: "desc" },
  { sortBy: "failed", sortOrder: "desc" },
  { sortBy: "waiting", sortOrder: "desc" },
];

export interface AppState {
  // Connection
  connected: boolean;
  error: string | null;

  // Global metrics
  globalMetrics: GlobalMetrics | null;

  // Queues. `queues` is the visible list (queueFilter applied); `allQueues`
  // is the full sorted observation the filter selects from. Selection indexes
  // (`selectedQueueIndex`) always refer to the visible list.
  queues: QueueStats[];
  allQueues: QueueStats[];
  queueFilter: string;
  queueSearchActive: boolean;
  selectedQueueIndex: number;
  queueSortBy: QueueSortBy;
  queueSortOrder: SortOrder;

  // Jobs
  jobs: JobSummary[];
  jobsTotal: number;
  jobsPage: number;
  jobsTotalPages: number;
  jobsStatus: JobListView;
  selectedJobIndex: number;

  // Detail view
  jobDetail: JobDetail | null;
  showJobDetail: boolean;

  // Schedulers (for repeatable jobs)
  schedulers: JobSchedulerSummary[];
  schedulersTotal: number;
  schedulersPage: number;
  schedulersTotalPages: number;
  selectedSchedulerIndex: number;
  schedulerDetail: JobSchedulerDetail | null;
  showSchedulerDetail: boolean;

  // UI state
  focusedPane: FocusedPane;
  showConfirmDelete: boolean;
  showPageJump: boolean;
  pageJumpInput: string;
  showCommandPalette: boolean;
  paletteQuery: string;
  paletteIndex: number;
  isLoading: boolean;
}

export type StateListener = (state: AppState) => void;

/** Case-insensitive substring filter on queue names. Empty filter = all. */
export function filterQueues(queues: QueueStats[], filter: string): QueueStats[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return queues;
  return queues.filter((queue) => queue.name.toLowerCase().includes(needle));
}

class StateManager {
  private state: AppState;
  private listeners: Set<StateListener> = new Set();

  constructor() {
    this.state = {
      connected: false,
      error: null,
      globalMetrics: null,
      queues: [],
      allQueues: [],
      queueFilter: "",
      queueSearchActive: false,
      selectedQueueIndex: 0,
      queueSortBy: "name",
      queueSortOrder: "asc",
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
      showCommandPalette: false,
      paletteQuery: "",
      paletteIndex: 0,
      isLoading: false,
    };
  }

  getState(): AppState {
    // Return a shallow copy to prevent accidental mutation of internal state
    return { ...this.state };
  }

  setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyListeners();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        // Log error but don't let one listener break others
        console.error("State listener error:", error instanceof Error ? error.message : error);
      }
    }
  }

  // Computed getters
  getSelectedQueue(): QueueStats | null {
    const { queues, selectedQueueIndex } = this.state;
    return queues[selectedQueueIndex] ?? null;
  }

  getSelectedJob(): JobSummary | null {
    const { jobs, selectedJobIndex } = this.state;
    return jobs[selectedJobIndex] ?? null;
  }

  // Queue navigation
  selectNextQueue(): void {
    const { queues, selectedQueueIndex } = this.state;
    if (selectedQueueIndex < queues.length - 1) {
      this.setState({
        selectedQueueIndex: selectedQueueIndex + 1,
        // Reset job selection when queue changes
        selectedJobIndex: 0,
        jobsPage: 1,
      });
    }
  }

  selectPrevQueue(): void {
    const { selectedQueueIndex } = this.state;
    if (selectedQueueIndex > 0) {
      this.setState({
        selectedQueueIndex: selectedQueueIndex - 1,
        selectedJobIndex: 0,
        jobsPage: 1,
      });
    }
  }

  cycleQueueSort(): void {
    const { queueSortBy, queueSortOrder, allQueues, queueFilter } = this.state;
    const currentIndex = QUEUE_SORT_SEQUENCE.findIndex(
      (option) => option.sortBy === queueSortBy && option.sortOrder === queueSortOrder,
    );
    const next = QUEUE_SORT_SEQUENCE[(currentIndex + 1) % QUEUE_SORT_SEQUENCE.length]!;
    const sortedQueues = sortQueues(allQueues, next.sortBy, next.sortOrder);
    this.setState({
      allQueues: sortedQueues,
      queues: filterQueues(sortedQueues, queueFilter),
      queueSortBy: next.sortBy,
      queueSortOrder: next.sortOrder,
      selectedQueueIndex: 0,
      selectedJobIndex: 0,
      jobsPage: 1,
    });
  }

  /**
   * Replace the queue observation (already sorted) and re-derive the visible
   * list from the active filter. Selection is preserved by queue name when
   * the queue is still visible, otherwise clamped — the same contract the
   * polling loop relied on before the filter existed.
   */
  applyQueues(allQueues: QueueStats[]): void {
    const visible = filterQueues(allQueues, this.state.queueFilter);
    this.setState({
      allQueues,
      queues: visible,
      selectedQueueIndex: this.remapSelection(visible),
    });
  }

  private remapSelection(visible: QueueStats[]): number {
    const previousName = this.state.queues[this.state.selectedQueueIndex]?.name;
    if (previousName) {
      const nextIndex = visible.findIndex((queue) => queue.name === previousName);
      if (nextIndex !== -1) return nextIndex;
    }
    return visible.length > 0 ? Math.min(this.state.selectedQueueIndex, visible.length - 1) : 0;
  }

  // Queue search (`/`)
  openQueueSearch(): void {
    this.setState({ queueSearchActive: true, focusedPane: "queues" });
  }

  /** Close search input. `keepFilter: false` (Escape) restores the full list. */
  closeQueueSearch(keepFilter: boolean): void {
    if (!keepFilter) {
      this.setQueueFilter("");
    }
    this.setState({ queueSearchActive: false });
  }

  setQueueFilter(filter: string): void {
    const visible = filterQueues(this.state.allQueues, filter);
    const previousName = this.state.queues[this.state.selectedQueueIndex]?.name;
    const keptIndex = previousName ? visible.findIndex((queue) => queue.name === previousName) : -1;
    const selectionChanged = keptIndex === -1;
    this.setState({
      queueFilter: filter,
      queues: visible,
      selectedQueueIndex: selectionChanged ? 0 : keptIndex,
      // The filter moved the selection to a different queue: job-pane
      // position no longer applies.
      ...(selectionChanged && { selectedJobIndex: 0, jobsPage: 1 }),
    });
  }

  appendQueueFilter(char: string): void {
    this.setQueueFilter(this.state.queueFilter + char);
  }

  backspaceQueueFilter(): void {
    this.setQueueFilter(this.state.queueFilter.slice(0, -1));
  }

  /** Set an explicit queue sort (command palette); `s` still cycles. */
  setQueueSort(sortBy: QueueSortBy, sortOrder?: SortOrder): void {
    const order = sortOrder ?? defaultSortOrder(sortBy);
    const sortedQueues = sortQueues(this.state.allQueues, sortBy, order);
    this.setState({
      allQueues: sortedQueues,
      queues: filterQueues(sortedQueues, this.state.queueFilter),
      queueSortBy: sortBy,
      queueSortOrder: order,
      selectedQueueIndex: 0,
      selectedJobIndex: 0,
      jobsPage: 1,
    });
  }

  // Command palette (Ctrl+P)
  openCommandPalette(): void {
    this.setState({ showCommandPalette: true, paletteQuery: "", paletteIndex: 0 });
  }

  closeCommandPalette(): void {
    this.setState({ showCommandPalette: false, paletteQuery: "", paletteIndex: 0 });
  }

  setPaletteQuery(query: string): void {
    // Typing changes the filtered list; restart the selection at the top.
    this.setState({ paletteQuery: query, paletteIndex: 0 });
  }

  movePaletteSelection(delta: number, listLength: number): void {
    if (listLength <= 0) return;
    const next = Math.max(0, Math.min(this.state.paletteIndex + delta, listLength - 1));
    this.setState({ paletteIndex: next });
  }

  // Job navigation
  selectNextJob(): void {
    const { jobs, selectedJobIndex } = this.state;
    if (selectedJobIndex < jobs.length - 1) {
      this.setState({ selectedJobIndex: selectedJobIndex + 1 });
    }
  }

  selectPrevJob(): void {
    const { selectedJobIndex } = this.state;
    if (selectedJobIndex > 0) {
      this.setState({ selectedJobIndex: selectedJobIndex - 1 });
    }
  }

  // Pagination
  nextPage(): void {
    const { jobsPage, jobsTotalPages } = this.state;
    if (jobsPage < jobsTotalPages) {
      this.setState({
        jobsPage: jobsPage + 1,
        selectedJobIndex: 0,
      });
    }
  }

  prevPage(): void {
    const { jobsPage } = this.state;
    if (jobsPage > 1) {
      this.setState({
        jobsPage: jobsPage - 1,
        selectedJobIndex: 0,
      });
    }
  }

  goToPage(page: number): void {
    const { jobsTotalPages } = this.state;
    const targetPage = Math.max(1, Math.min(page, jobsTotalPages));
    this.setState({
      jobsPage: targetPage,
      selectedJobIndex: 0,
    });
  }

  // Status filter
  setJobsStatus(status: JobListView): void {
    this.setState({
      jobsStatus: status,
      jobsPage: 1,
      selectedJobIndex: 0,
    });
  }

  // Focus management
  toggleFocus(): void {
    const { focusedPane } = this.state;
    this.setState({
      focusedPane: focusedPane === "queues" ? "jobs" : "queues",
    });
  }

  // Detail view
  openJobDetail(detail: JobDetail): void {
    this.setState({
      jobDetail: detail,
      showJobDetail: true,
    });
  }

  closeJobDetail(): void {
    this.setState({
      jobDetail: null,
      showJobDetail: false,
    });
  }

  // Delete confirmation
  showDeleteConfirm(): void {
    this.setState({ showConfirmDelete: true });
  }

  hideDeleteConfirm(): void {
    this.setState({ showConfirmDelete: false });
  }

  // Page jump
  showPageJumpModal(): void {
    this.setState({ showPageJump: true, pageJumpInput: "" });
  }

  hidePageJumpModal(): void {
    this.setState({ showPageJump: false, pageJumpInput: "" });
  }

  updatePageJumpInput(input: string): void {
    // Only allow numeric input
    const numericInput = input.replace(/\D/g, "");
    this.setState({ pageJumpInput: numericInput });
  }

  appendPageJumpInput(char: string): void {
    if (/^\d$/.test(char)) {
      const { pageJumpInput } = this.state;
      this.setState({ pageJumpInput: pageJumpInput + char });
    }
  }

  backspacePageJumpInput(): void {
    const { pageJumpInput } = this.state;
    this.setState({ pageJumpInput: pageJumpInput.slice(0, -1) });
  }

  // Scheduler navigation
  selectNextScheduler(): void {
    const { schedulers, selectedSchedulerIndex } = this.state;
    if (selectedSchedulerIndex < schedulers.length - 1) {
      this.setState({ selectedSchedulerIndex: selectedSchedulerIndex + 1 });
    }
  }

  selectPrevScheduler(): void {
    const { selectedSchedulerIndex } = this.state;
    if (selectedSchedulerIndex > 0) {
      this.setState({ selectedSchedulerIndex: selectedSchedulerIndex - 1 });
    }
  }

  getSelectedScheduler(): JobSchedulerSummary | null {
    const { schedulers, selectedSchedulerIndex } = this.state;
    return schedulers[selectedSchedulerIndex] ?? null;
  }

  // Scheduler pagination
  nextSchedulerPage(): void {
    const { schedulersPage, schedulersTotalPages } = this.state;
    if (schedulersPage < schedulersTotalPages) {
      this.setState({
        schedulersPage: schedulersPage + 1,
        selectedSchedulerIndex: 0,
      });
    }
  }

  prevSchedulerPage(): void {
    const { schedulersPage } = this.state;
    if (schedulersPage > 1) {
      this.setState({
        schedulersPage: schedulersPage - 1,
        selectedSchedulerIndex: 0,
      });
    }
  }

  goToSchedulerPage(page: number): void {
    const { schedulersTotalPages } = this.state;
    const targetPage = Math.max(1, Math.min(page, schedulersTotalPages));
    this.setState({
      schedulersPage: targetPage,
      selectedSchedulerIndex: 0,
    });
  }

  // Scheduler detail view
  openSchedulerDetail(detail: JobSchedulerDetail): void {
    this.setState({
      schedulerDetail: detail,
      showSchedulerDetail: true,
    });
  }

  closeSchedulerDetail(): void {
    this.setState({
      schedulerDetail: null,
      showSchedulerDetail: false,
    });
  }
}

// Singleton state manager
export const stateManager = new StateManager();
