import { connectRedis, disconnectRedis } from "./data/redis.js";
import { discoverQueueNames, getQueueStats, closeAllQueues } from "./data/queues.js";
import { getAllJobs, getJobDetail, VALID_JOB_STATUSES } from "./data/jobs.js";
import type { JsonJobStatus } from "./data/jobs.js";
import { getAllJobSchedulers, getJobSchedulerDetail } from "./data/schedulers.js";
import { writeError } from "./errors.js";
import type { Config, Subcommand } from "./config.js";
import { setConfig } from "./config.js";
import {
  formatQueuesOverview,
  formatJobsList,
  formatJobDetail,
  formatSchedulersList,
  formatSchedulerDetail,
} from "./formatters.js";

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
    writeError(`Scheduler '${schedulerKey}' not found in queue '${queueName}'`, "RUNTIME_ERROR");
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

function validateJobState(jobState: string | undefined): JsonJobStatus | undefined {
  if (!jobState) return undefined;

  if (!VALID_JOB_STATUSES.includes(jobState as JsonJobStatus)) {
    writeError(
      `Invalid --job-state value: '${jobState}'. Valid values: ${VALID_JOB_STATUSES.join(", ")}`,
      "CONFIG_ERROR",
    );
    process.exit(2);
  }

  return jobState as JsonJobStatus;
}

// ── Cleanup helper ──────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await closeAllQueues();
  await disconnectRedis();
}

// ── Route and execute ───────────────────────────────────────────────────

async function routeAndFetch(subcommand: Subcommand): Promise<unknown> {
  switch (subcommand.kind) {
    case "queues-list":
      return fetchQueuesOverview();

    case "jobs-list": {
      const validState = validateJobState(subcommand.jobState);
      return fetchJobsList(subcommand.queue, validState, subcommand.pageSize);
    }

    case "jobs-get":
      return fetchJobDetail(subcommand.queue, subcommand.jobId);

    case "schedulers-list":
      return fetchSchedulersList(subcommand.queue, subcommand.pageSize);

    case "schedulers-get":
      return fetchSchedulerDetail(subcommand.queue, subcommand.schedulerId);
  }
}

// ── Format output ───────────────────────────────────────────────────────

function formatOutput(result: unknown, subcommand: Subcommand, humanFriendly: boolean): string {
  if (!humanFriendly) {
    return JSON.stringify(result);
  }

  switch (subcommand.kind) {
    case "queues-list":
      return formatQueuesOverview(result as Parameters<typeof formatQueuesOverview>[0]);
    case "jobs-list":
      return formatJobsList(result as Parameters<typeof formatJobsList>[0]);
    case "jobs-get":
      return formatJobDetail(result as Parameters<typeof formatJobDetail>[0]);
    case "schedulers-list":
      return formatSchedulersList(result as Parameters<typeof formatSchedulersList>[0]);
    case "schedulers-get":
      return formatSchedulerDetail(result as Parameters<typeof formatSchedulerDetail>[0]);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function runJsonMode(
  config: Config,
  subcommand: Subcommand,
  humanFriendly?: boolean,
): Promise<void> {
  setConfig(config);

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
    const result = await routeAndFetch(subcommand);
    const output = formatOutput(result, subcommand, !!humanFriendly);
    process.stdout.write(output + "\n");
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
