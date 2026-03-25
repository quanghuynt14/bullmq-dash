import type { Job } from "bullmq";
import { getQueue } from "./queues.js";

export type JobListView =
  | "latest"
  | "wait"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "schedulers";

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
const DEFAULT_MAX_RESULTS = 1000;

/**
 * Valid job state values for the --job-state flag
 */
export const VALID_JOB_STATUSES = ["wait", "active", "completed", "failed", "delayed"] as const;
export type JsonJobStatus = (typeof VALID_JOB_STATUSES)[number];

/** A job paired with its known state, avoiding extra Redis round-trips. */
interface TaggedJob {
  job: Job;
  state: string;
}

/**
 * Get all jobs for a queue, optionally filtered by status.
 * Returns up to `maxResults` jobs (default 1000) to prevent OOM on huge queues.
 * Used by subcommand mode for bulk export.
 */
export async function getAllJobs(
  queueName: string,
  status?: JsonJobStatus,
  maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<{ jobs: JobSummary[]; total: number }> {
  const queue = getQueue(queueName);
  const end = maxResults - 1;

  let tagged: TaggedJob[];
  let total: number;

  if (!status) {
    // Fetch from all statuses, tag each batch with its known state
    const counts = await queue.getJobCounts();
    total =
      (counts.waiting || 0) +
      (counts.active || 0) +
      (counts.completed || 0) +
      (counts.failed || 0) +
      (counts.delayed || 0) +
      (counts.prioritized || 0);

    const [active, waiting, completed, failed, delayed, prioritized] = await Promise.all([
      queue.getActive(0, end),
      queue.getWaiting(0, end),
      queue.getCompleted(0, end),
      queue.getFailed(0, end),
      queue.getDelayed(0, end),
      queue.getPrioritized(0, end),
    ]);

    const allTagged: TaggedJob[] = [
      ...active.map((job) => ({ job, state: "active" })),
      ...waiting.map((job) => ({ job, state: "waiting" })),
      ...completed.map((job) => ({ job, state: "completed" })),
      ...failed.map((job) => ({ job, state: "failed" })),
      ...delayed.map((job) => ({ job, state: "delayed" })),
      ...prioritized.map((job) => ({ job, state: "prioritized" })),
    ];
    allTagged.sort((a, b) => (b.job.timestamp || 0) - (a.job.timestamp || 0));
    tagged = allTagged.slice(0, maxResults);
  } else if (status === "wait") {
    const waitCounts = await queue.getJobCounts("waiting", "prioritized");
    total = (waitCounts.waiting || 0) + (waitCounts.prioritized || 0);

    const [waitingJobs, prioritizedJobs] = await Promise.all([
      queue.getWaiting(0, end),
      queue.getPrioritized(0, end),
    ]);

    const combined: TaggedJob[] = [
      ...waitingJobs.map((job) => ({ job, state: "waiting" })),
      ...prioritizedJobs.map((job) => ({ job, state: "prioritized" })),
    ];
    tagged = combined.slice(0, maxResults);
  } else {
    switch (status) {
      case "active":
        tagged = (await queue.getActive(0, end)).map((job) => ({ job, state: "active" }));
        total = (await queue.getJobCounts("active")).active || 0;
        break;
      case "completed":
        tagged = (await queue.getCompleted(0, end)).map((job) => ({ job, state: "completed" }));
        total = (await queue.getJobCounts("completed")).completed || 0;
        break;
      case "failed":
        tagged = (await queue.getFailed(0, end)).map((job) => ({ job, state: "failed" }));
        total = (await queue.getJobCounts("failed")).failed || 0;
        break;
      case "delayed":
        tagged = (await queue.getDelayed(0, end)).map((job) => ({ job, state: "delayed" }));
        total = (await queue.getJobCounts("delayed")).delayed || 0;
        break;
      default:
        tagged = [];
        total = 0;
    }
  }

  const jobSummaries: JobSummary[] = tagged.map(({ job, state }) => ({
    id: job.id || "unknown",
    name: job.name,
    state,
    timestamp: job.timestamp || 0,
  }));

  return { jobs: jobSummaries, total };
}

/**
 * Get jobs by status with pagination
 */
export async function getJobs(
  queueName: string,
  status: JobListView,
  page: number = 1,
  pageSize: number = PAGE_SIZE,
): Promise<JobsResult> {
  const queue = getQueue(queueName);
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  let tagged: TaggedJob[];
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

    const allTagged: TaggedJob[] = [
      ...active.map((job) => ({ job, state: "active" })),
      ...waiting.map((job) => ({ job, state: "waiting" })),
      ...completed.map((job) => ({ job, state: "completed" })),
      ...failed.map((job) => ({ job, state: "failed" })),
      ...delayed.map((job) => ({ job, state: "delayed" })),
      ...prioritized.map((job) => ({ job, state: "prioritized" })),
    ];
    allTagged.sort((a, b) => (b.job.timestamp || 0) - (a.job.timestamp || 0));

    tagged = allTagged.slice(start, end + 1);
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
        const combinedWait: TaggedJob[] = [
          ...waitingJobs.map((job) => ({ job, state: "waiting" })),
          ...prioritizedJobs.map((job) => ({ job, state: "prioritized" })),
        ];
        tagged = combinedWait.slice(start, end + 1);
        break;
      case "active":
        tagged = (await queue.getActive(start, end)).map((job) => ({ job, state: "active" }));
        const activeCounts = await queue.getJobCounts("active");
        total = activeCounts.active || 0;
        break;
      case "completed":
        tagged = (await queue.getCompleted(start, end)).map((job) => ({
          job,
          state: "completed",
        }));
        const completedCounts = await queue.getJobCounts("completed");
        total = completedCounts.completed || 0;
        break;
      case "failed":
        tagged = (await queue.getFailed(start, end)).map((job) => ({ job, state: "failed" }));
        const failedCounts = await queue.getJobCounts("failed");
        total = failedCounts.failed || 0;
        break;
      case "delayed":
        tagged = (await queue.getDelayed(start, end)).map((job) => ({ job, state: "delayed" }));
        const delayedCounts = await queue.getJobCounts("delayed");
        total = delayedCounts.delayed || 0;
        break;
      case "schedulers":
        // Schedulers are not jobs - use getJobSchedulers() from schedulers.ts instead
        throw new Error("Cannot fetch schedulers via getJobs(). Use getJobSchedulers() instead.");
      default:
        tagged = [];
        total = 0;
    }
  }

  // Convert tagged jobs to summaries (no extra Redis calls needed)
  const jobSummaries: JobSummary[] = tagged.map(({ job, state }) => ({
    id: job.id || "unknown",
    name: job.name,
    state,
    timestamp: job.timestamp || 0,
  }));

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
