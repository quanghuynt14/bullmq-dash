import { getQueue } from "./queues.js";
import type { Job } from "bullmq";

/**
 * Summary info for scheduler list view
 */
export interface JobSchedulerSummary {
  key: string;
  name: string;
  pattern?: string;
  every?: number;
  next?: number;
  iterationCount?: number;
  tz?: string;
}

/**
 * Info about the next delayed job waiting to be processed
 */
export interface NextDelayedJob {
  id: string;
  state: string;
  timestamp: number;
  delay?: number;
  data: unknown;
  opts: unknown;
}

/**
 * Info about a recent job from history
 */
export interface RecentJobInfo {
  id: string;
  state: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
}

/**
 * Full scheduler details for detail view
 */
export interface JobSchedulerDetail extends JobSchedulerSummary {
  id?: string | null;
  limit?: number;
  startDate?: number;
  endDate?: number;
  template?: {
    data?: unknown;
    opts?: unknown;
  };
  // Next delayed job info (the job waiting to run)
  nextJob?: NextDelayedJob;
  // Recent job history (last N jobs from this scheduler)
  recentJobs?: RecentJobInfo[];
}

export interface SchedulersResult {
  schedulers: JobSchedulerSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const PAGE_SIZE = 25;

/**
 * Get job schedulers with pagination
 */
export async function getJobSchedulers(
  queueName: string,
  page: number = 1,
  pageSize: number = PAGE_SIZE,
): Promise<SchedulersResult> {
  const queue = getQueue(queueName);
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  const [schedulers, total] = await Promise.all([
    queue.getJobSchedulers(start, end, false),
    queue.getJobSchedulersCount(),
  ]);

  const summaries: JobSchedulerSummary[] = schedulers.map((s) => ({
    key: s.key,
    name: s.name,
    pattern: s.pattern ?? undefined,
    every: s.every ?? undefined,
    next: s.next ?? undefined,
    iterationCount: s.iterationCount ?? undefined,
    tz: s.tz ?? undefined,
  }));

  return {
    schedulers: summaries,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Get detailed information for a single job scheduler
 */
export async function getJobSchedulerDetail(
  queueName: string,
  schedulerKey: string,
): Promise<JobSchedulerDetail | null> {
  const queue = getQueue(queueName);

  // Fetch all schedulers and find the one with matching key
  // (BullMQ doesn't have a direct getJobScheduler(key) method)
  const schedulers = await queue.getJobSchedulers(0, -1, false);
  const scheduler = schedulers.find((s) => s.key === schedulerKey);

  if (!scheduler) {
    return null;
  }

  // Find the next delayed job for this scheduler
  // Delayed jobs created by schedulers have repeatJobKey set
  const delayedJobs = await queue.getDelayed(0, 100);
  const nextDelayedJob = delayedJobs.find((job) => job.repeatJobKey === schedulerKey);

  let nextJob: NextDelayedJob | undefined;
  if (nextDelayedJob) {
    const state = await nextDelayedJob.getState();
    nextJob = {
      id: nextDelayedJob.id || "unknown",
      state,
      timestamp: nextDelayedJob.timestamp || 0,
      delay: nextDelayedJob.delay,
      data: nextDelayedJob.data,
      opts: nextDelayedJob.opts,
    };
  }

  // Find recent job history for this scheduler
  // Check completed and failed jobs for ones with matching repeatJobKey
  const [completedJobs, failedJobs] = await Promise.all([
    queue.getCompleted(0, 50),
    queue.getFailed(0, 50),
  ]);

  // Filter jobs that belong to this scheduler and get their details
  const allHistoryJobs: Job[] = [...completedJobs, ...failedJobs].filter(
    (job) => job.repeatJobKey === schedulerKey,
  );

  // Sort by timestamp descending and take most recent 10
  allHistoryJobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const recentHistoryJobs = allHistoryJobs.slice(0, 10);

  const recentJobs: RecentJobInfo[] = await Promise.all(
    recentHistoryJobs.map(async (job) => {
      const state = await job.getState();
      return {
        id: job.id || "unknown",
        state,
        timestamp: job.timestamp || 0,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
      };
    }),
  );

  return {
    key: scheduler.key,
    name: scheduler.name,
    id: scheduler.id,
    pattern: scheduler.pattern ?? undefined,
    every: scheduler.every ?? undefined,
    next: scheduler.next ?? undefined,
    iterationCount: scheduler.iterationCount ?? undefined,
    tz: scheduler.tz ?? undefined,
    limit: scheduler.limit ?? undefined,
    startDate: scheduler.startDate ?? undefined,
    endDate: scheduler.endDate ?? undefined,
    template: scheduler.template
      ? {
          data: scheduler.template.data,
          opts: scheduler.template.opts,
        }
      : undefined,
    nextJob,
    recentJobs: recentJobs.length > 0 ? recentJobs : undefined,
  };
}

/**
 * Format interval (every) to human-readable string
 */
export function formatInterval(ms: number | undefined): string {
  if (!ms) return "N/A";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format next run time to relative string
 */
export function formatNextRun(timestamp: number | undefined): string {
  if (!timestamp) return "N/A";

  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) return "now";

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return `in ${seconds}s`;
}

/**
 * Format timestamp to ISO string
 */
export function formatSchedulerTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "N/A";
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Get schedule description (pattern or interval)
 */
export function getScheduleDescription(scheduler: JobSchedulerSummary): string {
  if (scheduler.pattern) {
    return scheduler.pattern;
  }
  if (scheduler.every) {
    return `every ${formatInterval(scheduler.every)}`;
  }
  return "N/A";
}
