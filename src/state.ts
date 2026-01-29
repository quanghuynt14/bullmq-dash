import type { QueueStats } from "./data/queues.js";
import type { JobSummary, JobDetail, JobListView } from "./data/jobs.js";
import type { GlobalMetrics } from "./data/metrics.js";
import type { JobSchedulerSummary, JobSchedulerDetail } from "./data/schedulers.js";

export type FocusedPane = "queues" | "jobs";

export interface AppState {
  // Connection
  connected: boolean;
  error: string | null;

  // Global metrics
  globalMetrics: GlobalMetrics | null;

  // Queues
  queues: QueueStats[];
  selectedQueueIndex: number;

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
  isLoading: boolean;
}

export type StateListener = (state: AppState) => void;

class StateManager {
  private state: AppState;
  private listeners: Set<StateListener> = new Set();

  constructor() {
    this.state = {
      connected: false,
      error: null,
      globalMetrics: null,
      queues: [],
      selectedQueueIndex: 0,
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
