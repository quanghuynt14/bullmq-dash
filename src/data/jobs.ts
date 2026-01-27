import type { Job } from "bullmq";
import { getQueue } from "./queues.js";

export type JobStatus = "latest" | "wait" | "active" | "completed" | "failed" | "delayed" | "scheduled";

export interface JobSummary {
  id: string;
  name: string;
  state: string;
  timestamp: number;
}

export interface JobDetail extends JobSummary {
  data: unknown;
  opts: unknown;
  attemptsMade: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
  processedOn?: number;
  finishedOn?: number;
  progress?: number | object;
  repeatJobKey?: string;
  delay?: number;
}

export interface JobsResult {
  jobs: JobSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const PAGE_SIZE = 25;

/**
 * Get jobs by status with pagination
 */
export async function getJobs(
  queueName: string,
  status: JobStatus,
  page: number = 1,
  pageSize: number = PAGE_SIZE,
): Promise<JobsResult> {
  const queue = getQueue(queueName);
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  let jobs: Job[];
  let total: number;

  if (status === "latest") {
    // For "latest" status, we fetch from all job statuses sorted by timestamp
    // Use proper pagination by fetching the required range from each category
    const counts = await queue.getJobCounts();

    total =
      (counts.waiting || 0) +
      (counts.active || 0) +
      (counts.completed || 0) +
      (counts.failed || 0) +
      (counts.delayed || 0) +
      (counts.prioritized || 0);

    // Fetch jobs from all categories with proper pagination
    // We need to fetch enough from each category to cover the requested page
    // Since jobs are sorted by timestamp across all categories, we fetch `end + 1` from each
    const [active, waiting, completed, failed, delayed, prioritized] = await Promise.all([
      queue.getActive(0, end),
      queue.getWaiting(0, end),
      queue.getCompleted(0, end),
      queue.getFailed(0, end),
      queue.getDelayed(0, end),
      queue.getPrioritized(0, end),
    ]);

    const allJobs = [...active, ...waiting, ...completed, ...failed, ...delayed, ...prioritized];
    allJobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    jobs = allJobs.slice(start, end + 1);
  } else {
    // Fetch specific status
    switch (status) {
      case "wait":
        // For "wait" status, combine waiting and prioritized jobs with proper pagination
        const waitCounts = await queue.getJobCounts("waiting", "prioritized");
        total = (waitCounts.waiting || 0) + (waitCounts.prioritized || 0);

        // Fetch enough from each category to cover the requested page
        const [waitingJobs, prioritizedJobs] = await Promise.all([
          queue.getWaiting(0, end),
          queue.getPrioritized(0, end),
        ]);

        // Combine and slice for correct pagination
        const combinedWait = [...waitingJobs, ...prioritizedJobs];
        jobs = combinedWait.slice(start, end + 1);
        break;
      case "active":
        jobs = await queue.getActive(start, end);
        const activeCounts = await queue.getJobCounts("active");
        total = activeCounts.active || 0;
        break;
      case "completed":
        jobs = await queue.getCompleted(start, end);
        const completedCounts = await queue.getJobCounts("completed");
        total = completedCounts.completed || 0;
        break;
      case "failed":
        jobs = await queue.getFailed(start, end);
        const failedCounts = await queue.getJobCounts("failed");
        total = failedCounts.failed || 0;
        break;
      case "delayed":
        jobs = await queue.getDelayed(start, end);
        const delayedCounts = await queue.getJobCounts("delayed");
        total = delayedCounts.delayed || 0;
        break;
      default:
        jobs = [];
        total = 0;
    }
  }

  // Get state for each job and convert to summary
  const jobSummaries: JobSummary[] = await Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      return {
        id: job.id || "unknown",
        name: job.name,
        state,
        timestamp: job.timestamp || 0,
      };
    }),
  );

  return {
    jobs: jobSummaries,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Get detailed information for a single job
 */
export async function getJobDetail(queueName: string, jobId: string): Promise<JobDetail | null> {
  const queue = getQueue(queueName);
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await job.getState();

  return {
    id: job.id || "unknown",
    name: job.name,
    state,
    timestamp: job.timestamp || 0,
    data: job.data,
    opts: job.opts,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    stacktrace: job.stacktrace,
    returnvalue: job.returnvalue,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    progress: job.progress as number | object | undefined,
    repeatJobKey: job.repeatJobKey,
    delay: job.delay,
  };
}

/**
 * Delete a job from a queue
 */
export async function deleteJob(queueName: string, jobId: string): Promise<boolean> {
  const queue = getQueue(queueName);
  const job = await queue.getJob(jobId);

  if (!job) {
    return false;
  }

  await job.remove();
  return true;
}

/**
 * Format timestamp to relative time string
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 0) return `${seconds}s ago`;
  return "just now";
}

/**
 * Format timestamp to ISO string
 */
export function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "N/A";
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}
