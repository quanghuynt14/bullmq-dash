import { connectRedis, disconnectRedis } from "./data/redis.js";
import { discoverQueueNames, getQueueStats, closeAllQueues } from "./data/queues.js";
import { getAllJobs, getJobDetail, VALID_JOB_STATUSES } from "./data/jobs.js";
import type { JsonJobStatus } from "./data/jobs.js";
import { getAllJobSchedulers, getJobSchedulerDetail } from "./data/schedulers.js";
import { writeError } from "./errors.js";
import type { Config, CliArgs } from "./config.js";
import { setConfig } from "./config.js";

/**
 * JSON mode query options extracted from CLI args
 */
interface JsonQueryOptions {
  queue?: string;
  jobState?: JsonJobStatus;
  jobId?: string;
  schedulers?: boolean;
  schedulerId?: string;
  pageSize?: number;
}

// ── Queues overview (default) ───────────────────────────────────────────

async function fetchQueuesOverview() {
  const queueNames = await discoverQueueNames();
  const queues = await Promise.all(queueNames.map((name) => getQueueStats(name)));

  const jobCounts = queues.reduce(
    (acc, q) => ({
      wait: acc.wait + q.counts.wait,
      active: acc.active + q.counts.active,
      completed: acc.completed + q.counts.completed,
      failed: acc.failed + q.counts.failed,
      delayed: acc.delayed + q.counts.delayed,
      total: acc.total + q.total,
    }),
    { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 },
  );

  return {
    timestamp: new Date().toISOString(),
    queues,
    metrics: {
      queueCount: queues.length,
      jobCounts,
    },
  };
}

// ── Jobs list ───────────────────────────────────────────────────────────

async function fetchJobsList(queueName: string, jobState?: JsonJobStatus, maxResults?: number) {
  const { jobs, total } = await getAllJobs(queueName, jobState, maxResults);

  return {
    timestamp: new Date().toISOString(),
    queue: queueName,
    jobState: jobState ?? "all",
    jobs,
    total,
  };
}

// ── Job detail ──────────────────────────────────────────────────────────

async function fetchJobDetail(queueName: string, jobId: string) {
  const job = await getJobDetail(queueName, jobId);

  if (!job) {
    writeError(`Job '${jobId}' not found in queue '${queueName}'`, "RUNTIME_ERROR");
    await cleanup();
    process.exit(1);
  }

  return {
    timestamp: new Date().toISOString(),
    queue: queueName,
    job,
  };
}

// ── Schedulers list ─────────────────────────────────────────────────────

async function fetchSchedulersList(queueName: string, maxResults?: number) {
  const { schedulers, total } = await getAllJobSchedulers(queueName, maxResults);

  return {
    timestamp: new Date().toISOString(),
    queue: queueName,
    schedulers,
    total,
  };
}

// ── Scheduler detail ────────────────────────────────────────────────────

async function fetchSchedulerDetail(queueName: string, schedulerKey: string) {
  const scheduler = await getJobSchedulerDetail(queueName, schedulerKey);

  if (!scheduler) {
    writeError(
      `Scheduler '${schedulerKey}' not found in queue '${queueName}'`,
      "RUNTIME_ERROR",
    );
    await cleanup();
    process.exit(1);
  }

  return {
    timestamp: new Date().toISOString(),
    queue: queueName,
    scheduler,
  };
}

// ── Validation ──────────────────────────────────────────────────────────

function validateOptions(opts: JsonQueryOptions): void {
  // --queue is required for all query-specific flags
  if (!opts.queue && (opts.jobId || opts.jobState || opts.schedulers || opts.schedulerId)) {
    writeError(
      "--queue is required when using --job-id, --job-state, --schedulers, or --scheduler-id",
      "CONFIG_ERROR",
    );
    process.exit(2);
  }

  // --job-id and --job-state are mutually exclusive
  if (opts.jobId && opts.jobState) {
    writeError("--job-id and --job-state cannot be used together", "CONFIG_ERROR");
    process.exit(2);
  }

  // --job-id and --schedulers/--scheduler-id are mutually exclusive
  if (opts.jobId && (opts.schedulers || opts.schedulerId)) {
    writeError("--job-id cannot be used with --schedulers or --scheduler-id", "CONFIG_ERROR");
    process.exit(2);
  }

  // --job-state and --schedulers/--scheduler-id are mutually exclusive
  if (opts.jobState && (opts.schedulers || opts.schedulerId)) {
    writeError("--job-state cannot be used with --schedulers or --scheduler-id", "CONFIG_ERROR");
    process.exit(2);
  }

  // Validate --job-state value
  if (opts.jobState && !VALID_JOB_STATUSES.includes(opts.jobState)) {
    writeError(
      `Invalid --job-state value: '${opts.jobState}'. Valid values: ${VALID_JOB_STATUSES.join(", ")}`,
      "CONFIG_ERROR",
    );
    process.exit(2);
  }
}

// ── Cleanup helper ──────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await closeAllQueues();
  await disconnectRedis();
}

// ── Route and execute ───────────────────────────────────────────────────

async function routeAndFetch(opts: JsonQueryOptions): Promise<unknown> {
  if (!opts.queue) {
    // Default: queues overview
    return fetchQueuesOverview();
  }

  if (opts.jobId) {
    return fetchJobDetail(opts.queue, opts.jobId);
  }

  if (opts.schedulerId) {
    return fetchSchedulerDetail(opts.queue, opts.schedulerId);
  }

  if (opts.schedulers) {
    return fetchSchedulersList(opts.queue, opts.pageSize);
  }

  // Default for --queue: list jobs
  return fetchJobsList(opts.queue, opts.jobState, opts.pageSize);
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function runJsonMode(config: Config, cliArgs: CliArgs): Promise<void> {
  setConfig(config);

  const opts: JsonQueryOptions = {
    queue: cliArgs.queue,
    jobState: cliArgs.jobState as JsonJobStatus | undefined,
    jobId: cliArgs.jobId,
    schedulers: cliArgs.schedulers,
    schedulerId: cliArgs.schedulerId,
    pageSize: cliArgs.pageSize,
  };

  validateOptions(opts);

  try {
    await connectRedis();
  } catch (error) {
    writeError(
      "Redis connection failed",
      "REDIS_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(3);
  }

  try {
    const result = await routeAndFetch(opts);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    writeError(
      "Failed to fetch data",
      "RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    await cleanup();
    process.exit(1);
  }

  await cleanup();
  process.exit(0);
}
