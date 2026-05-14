import { discoverQueueNames, getQueueStats, closeAllQueues, deleteQueue } from "./data/queues.js";
import { getAllJobs, getJobDetail, retryFailedJobs, VALID_JOB_STATUSES } from "./data/jobs.js";
import type { JsonJobStatus, RetryResult } from "./data/jobs.js";
import { getAllJobSchedulers, getJobSchedulerDetail } from "./data/schedulers.js";
import { writeError } from "./errors.js";
import { upsertJobs } from "./data/sqlite.js";
import { markPolledWrites } from "./data/sync.js";
import type { Subcommand } from "./cli.js";
import type { Config } from "./config.js";
import { setConfig } from "./config.js";
import { createContext, type Context } from "./context.js";
import {
  formatQueuesOverview,
  formatJobsList,
  formatJobDetail,
  formatJobsRetry,
  formatSchedulersList,
  formatSchedulerDetail,
  formatQueuesDelete,
} from "./formatters.js";

import readline from "node:readline";

// ── Helpers ─────────────────────────────────────────────────────────────

function createResponse<T>(data: T): { timestamp: string } & T {
  return {
    timestamp: new Date().toISOString(),
    ...data,
  };
}

// ── Queues overview (default) ───────────────────────────────────────────

async function fetchQueuesOverview(ctx: Context) {
  const queueNames = await discoverQueueNames(ctx);
  const queues = await Promise.all(queueNames.map((name) => getQueueStats(ctx, name)));

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

  return createResponse({
    queues,
    metrics: {
      queueCount: queues.length,
      jobCounts,
    },
  });
}

async function fetchQueuesDelete(ctx: Context, queueName: string, dryRun: boolean) {
  const result = await deleteQueue(ctx, queueName, dryRun);

  return createResponse({
    queue: queueName,
    deleted: !dryRun,
    dryRun,
    jobCounts: result.counts,
    totalJobs:
      result.counts.wait +
      result.counts.active +
      result.counts.completed +
      result.counts.failed +
      result.counts.delayed,
  });
}

// ── Jobs list ───────────────────────────────────────────────────────────

async function fetchJobsList(
  ctx: Context,
  queueName: string,
  jobState?: JsonJobStatus,
  maxResults?: number,
) {
  const { jobs, total } = await getAllJobs(ctx, queueName, jobState, maxResults, true);

  // Side effect: populate SQLite cache with fetched jobs (best-effort).
  // markPolledWrites tells the background sync not to overwrite this fresh
  // state with a stale staging snapshot.
  try {
    upsertJobs(
      ctx,
      queueName,
      jobs.map((j) => ({
        id: j.id,
        name: j.name,
        state: j.state,
        timestamp: j.timestamp,
        data: j.data,
      })),
    );
    markPolledWrites(
      queueName,
      jobs.map((j) => j.id),
    );
  } catch {
    // SQLite upsert is best-effort; don't break CLI output on failure
  }

  return createResponse({
    queue: queueName,
    jobState: jobState ?? "all",
    jobs,
    total,
  });
}

// ── Jobs retry ──────────────────────────────────────────────────────────

export interface JobsRetryOutput {
  timestamp: string;
  command: "jobs-retry";
  dryRun: boolean;
  queue: string;
  filter: { jobState: string; since?: string; name?: string };
  matched: number;
  retried: number;
  errors: RetryResult["errors"];
  sampleJobIds: string[];
  totalFailed: number;
  truncated: boolean;
}

/**
 * Exit-code contract for `jobs retry`: 3 on real partial failure, 0 otherwise.
 * Dry-run always exits 0 — it's informational by definition.
 */
export function computeRetryExitCode(result: JobsRetryOutput): number {
  if (!result.dryRun && result.errors.length > 0) return 3;
  return 0;
}

async function fetchJobsRetry(
  ctx: Context,
  queueName: string,
  jobState: string,
  since: string | undefined,
  name: string | undefined,
  pageSize: number | undefined,
  dryRun: boolean,
): Promise<JobsRetryOutput> {
  const result = await retryFailedJobs(ctx, queueName, { since, name, pageSize, dryRun });

  const filter: JobsRetryOutput["filter"] = { jobState };
  if (since !== undefined) filter.since = since;
  if (name !== undefined) filter.name = name;

  return createResponse({
    command: "jobs-retry",
    dryRun,
    queue: queueName,
    filter,
    matched: result.matched,
    retried: result.retried,
    errors: result.errors,
    sampleJobIds: result.sampleJobIds,
    totalFailed: result.totalFailed,
    truncated: result.truncated,
  });
}

// ── Job detail ──────────────────────────────────────────────────────────

async function fetchJobDetail(ctx: Context, queueName: string, jobId: string) {
  const job = await getJobDetail(ctx, queueName, jobId);

  if (!job) {
    writeError(`Job '${jobId}' not found in queue '${queueName}'`, "RUNTIME_ERROR");
    try {
      await cleanup(ctx);
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }

  return createResponse({
    queue: queueName,
    job,
  });
}

// ── Schedulers list ─────────────────────────────────────────────────────

async function fetchSchedulersList(ctx: Context, queueName: string, maxResults?: number) {
  const { schedulers, total } = await getAllJobSchedulers(ctx, queueName, maxResults);

  return createResponse({
    queue: queueName,
    schedulers,
    total,
  });
}

// ── Scheduler detail ────────────────────────────────────────────────────

async function fetchSchedulerDetail(ctx: Context, queueName: string, schedulerKey: string) {
  const scheduler = await getJobSchedulerDetail(ctx, queueName, schedulerKey);

  if (!scheduler) {
    writeError(`Scheduler '${schedulerKey}' not found in queue '${queueName}'`, "RUNTIME_ERROR");
    try {
      await cleanup(ctx);
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }

  return createResponse({
    queue: queueName,
    scheduler,
  });
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

function promptConfirmation(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${message} [y/N] `, (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

// ── Cleanup helper ──────────────────────────────────────────────────────

async function cleanup(ctx: Context): Promise<void> {
  await closeAllQueues(ctx);
  await ctx.redis.quit().catch(() => {});
  ctx.db.close();
}

// ── Route and execute ───────────────────────────────────────────────────

async function routeAndFetch(ctx: Context, subcommand: Subcommand): Promise<unknown> {
  switch (subcommand.kind) {
    case "queues-list":
      return fetchQueuesOverview(ctx);

    case "queues-delete":
      return fetchQueuesDelete(ctx, subcommand.queue, subcommand.dryRun ?? false);

    case "jobs-list": {
      const validState = validateJobState(subcommand.jobState);
      return fetchJobsList(ctx, subcommand.queue, validState, subcommand.pageSize);
    }

    case "jobs-get":
      return fetchJobDetail(ctx, subcommand.queue, subcommand.jobId);

    case "jobs-retry": {
      const validState = validateJobState(subcommand.jobState);
      if (!validState) throw new Error("jobs retry requires --job-state");
      return fetchJobsRetry(
        ctx,
        subcommand.queue,
        validState,
        subcommand.since,
        subcommand.name,
        subcommand.pageSize,
        subcommand.dryRun,
      );
    }

    case "schedulers-list":
      return fetchSchedulersList(ctx, subcommand.queue, subcommand.pageSize);

    case "schedulers-get":
      return fetchSchedulerDetail(ctx, subcommand.queue, subcommand.schedulerId);

    default: {
      const _exhaustive: never = subcommand;
      throw new Error(`Unhandled subcommand: ${(_exhaustive as Subcommand).kind}`);
    }
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
    case "queues-delete":
      return formatQueuesDelete(result as Parameters<typeof formatQueuesDelete>[0]);
    case "jobs-list":
      return formatJobsList(result as Parameters<typeof formatJobsList>[0]);
    case "jobs-get":
      return formatJobDetail(result as Parameters<typeof formatJobDetail>[0]);
    case "jobs-retry":
      return formatJobsRetry(result as Parameters<typeof formatJobsRetry>[0]);
    case "schedulers-list":
      return formatSchedulersList(result as Parameters<typeof formatSchedulersList>[0]);
    case "schedulers-get":
      return formatSchedulerDetail(result as Parameters<typeof formatSchedulerDetail>[0]);

    default: {
      const _exhaustive: never = subcommand;
      throw new Error(`Unhandled subcommand format: ${(_exhaustive as Subcommand).kind}`);
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function runJsonMode(
  config: Config,
  subcommand: Subcommand,
  humanFriendly: boolean = false,
  dryRun: boolean = false,
  yes: boolean = false,
): Promise<void> {
  // TODO(#22): drop alongside getConfig. Until then, keep the singleton
  // populated for any helper that still reads getConfig().
  setConfig(config);
  const ctx = createContext(config);

  if (subcommand.kind === "queues-delete" && !yes && !dryRun) {
    if (process.stdin.isTTY) {
      const confirmed = await promptConfirmation(
        `Delete queue '${subcommand.queue}' and all its jobs? This cannot be undone.`,
      );
      if (!confirmed) {
        process.stderr.write("Cancelled.\n");
        await cleanup(ctx);
        process.exit(1);
      }
    } else {
      writeError(
        "Confirmation required: run with --yes flag in non-interactive mode",
        "CONFIG_ERROR",
        "Use --yes to skip confirmation in scripts, or run in interactive terminal.",
      );
      process.exit(2);
    }
  }

  try {
    await ctx.redis.connect();
  } catch (error) {
    writeError(
      "Redis connection failed",
      "REDIS_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }

  let exitCode = 0;
  try {
    const result = await routeAndFetch(ctx, subcommand);
    const output = formatOutput(result, subcommand, humanFriendly);
    process.stdout.write(output + "\n");

    // jobs-retry has a richer exit-code contract: non-zero when the caller
    // needs to know a real live retry ran into per-job errors. Dry-run always
    // returns 0 — it's informational by definition.
    if (subcommand.kind === "jobs-retry") {
      exitCode = computeRetryExitCode(result as JobsRetryOutput);
    }
  } catch (error) {
    writeError(
      "Failed to fetch data",
      "RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    try {
      await cleanup(ctx);
    } catch {
      // Ignore cleanup errors — the original error has already been reported
    }
    process.exit(1);
  }

  await cleanup(ctx);
  process.exit(exitCode);
}
