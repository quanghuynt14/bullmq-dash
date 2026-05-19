import type { Context } from "../context.js";
import type { QueueStats } from "./queues.js";
import type { JobDetail, JobListView, JobsResult, JobSummary } from "./jobs.js";
import type { JobSchedulerSummary, SchedulersResult } from "./schedulers.js";
import {
  getJobFromDb,
  queryJobs,
  queryQueueStats,
  querySchedulers,
  upsertJobs,
  upsertQueueStats,
  upsertSchedulers,
  type JobRow,
  type StoredJobObservation,
} from "./sqlite.js";

const DEFAULT_PAGE_SIZE = 25;

export type ObservedJob = StoredJobObservation;

export interface ObservationOptions {
  observedAt?: number;
}

export interface ObservationResult {
  observed: number;
}

export interface ListJobsOptions {
  state?: JobListView | string;
  page?: number;
  pageSize?: number;
}

export interface SearchJobsOptions extends ListJobsOptions {}

export interface ExpireStaleRecordsOptions {
  now?: number;
}

export interface ExpireStaleRecordsResult {
  queuesDeleted: number;
  schedulersDeleted: number;
  jobsDeleted: number;
}

interface CacheDimensionState {
  count: number;
  staleCount: number;
  oldestObservedAt: number | null;
  newestObservedAt: number | null;
}

export interface QueueCacheState {
  cacheTtlMs: number;
  queue: {
    exists: boolean;
    lastObservedAt: number | null;
    isStale: boolean;
  };
  jobs: CacheDimensionState;
  schedulers: CacheDimensionState;
}

export interface CachedJobDetail extends JobDetail {
  lastObservedAt: number;
}

function stateFilter(state: JobListView | string | undefined): string | string[] | undefined {
  switch (state) {
    case undefined:
    case "latest":
    case "all":
      return undefined;
    case "wait":
      return ["waiting", "prioritized"];
    case "schedulers":
      throw new Error("Cannot list schedulers via listJobs(). Use listSchedulers() instead.");
    default:
      return state;
  }
}

function rowToSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    name: row.name ?? "unknown",
    state: row.state,
    timestamp: row.timestamp ?? 0,
    lastObservedAt: row.last_observed_at,
  };
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function rowToDetail(row: JobRow): CachedJobDetail {
  const detail: CachedJobDetail = {
    id: row.id,
    name: row.name ?? "unknown",
    state: row.state,
    timestamp: row.timestamp ?? 0,
    data: parseJson(row.data_json),
    opts: parseJson(row.opts_json),
    attemptsMade: row.attempts_made ?? 0,
    lastObservedAt: row.last_observed_at,
  };

  if (row.failed_reason !== null) detail.failedReason = row.failed_reason;
  if (row.stacktrace_json !== null) detail.stacktrace = parseJson(row.stacktrace_json) as string[];
  if (row.returnvalue_json !== null) detail.returnvalue = parseJson(row.returnvalue_json);
  if (row.processed_on !== null) detail.processedOn = row.processed_on;
  if (row.finished_on !== null) detail.finishedOn = row.finished_on;
  if (row.progress_json !== null) detail.progress = parseJson(row.progress_json) as number | object;
  if (row.repeat_job_key !== null) detail.repeatJobKey = row.repeat_job_key;
  if (row.delay !== null) detail.delay = row.delay;

  return detail;
}

export function listQueues(ctx: Context): QueueStats[] {
  return queryQueueStats(ctx);
}

export function listJobs(ctx: Context, queue: string, options: ListJobsOptions = {}): JobsResult {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const result = queryJobs(ctx, {
    queue,
    state: stateFilter(options.state),
    sort: "timestamp",
    order: "desc",
    page,
    pageSize,
  });

  return {
    jobs: result.jobs.map(rowToSummary),
    total: result.total,
    page,
    pageSize,
    totalPages: Math.ceil(result.total / pageSize),
  };
}

export function searchJobs(
  ctx: Context,
  queue: string,
  query: string,
  options: SearchJobsOptions = {},
): JobsResult {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const result = queryJobs(ctx, {
    queue,
    search: query,
    state: stateFilter(options.state),
    sort: "timestamp",
    order: "desc",
    page,
    pageSize,
  });

  return {
    jobs: result.jobs.map(rowToSummary),
    total: result.total,
    page,
    pageSize,
    totalPages: Math.ceil(result.total / pageSize),
  };
}

export function getJob(ctx: Context, queue: string, id: string): CachedJobDetail | null {
  const row = getJobFromDb(ctx, queue, id);
  return row ? rowToDetail(row) : null;
}

export function listSchedulers(
  ctx: Context,
  queue: string,
  options: { page?: number; pageSize?: number } = {},
): SchedulersResult {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const result = querySchedulers(ctx, queue, page, pageSize);
  return {
    schedulers: result.schedulers,
    total: result.total,
    page,
    pageSize,
    totalPages: Math.ceil(result.total / pageSize),
  };
}

export function recordObservedQueues(
  ctx: Context,
  queues: QueueStats[],
  options: ObservationOptions = {},
): ObservationResult {
  upsertQueueStats(ctx, queues, options.observedAt ?? Date.now());
  return { observed: queues.length };
}

export function recordObservedJobs(
  ctx: Context,
  queue: string,
  jobs: ObservedJob[],
  options: ObservationOptions = {},
): ObservationResult {
  upsertJobs(ctx, queue, jobs, options.observedAt ?? Date.now());
  return { observed: jobs.length };
}

export function recordObservedSchedulers(
  ctx: Context,
  queue: string,
  schedulers: JobSchedulerSummary[],
  options: ObservationOptions = {},
): ObservationResult {
  upsertSchedulers(ctx, queue, schedulers, options.observedAt ?? Date.now());
  return { observed: schedulers.length };
}

function staleCutoff(ctx: Context, now: number): number {
  return now - ctx.config.cacheTtlMs;
}

export function expireStaleRecords(
  ctx: Context,
  options: ExpireStaleRecordsOptions = {},
): ExpireStaleRecordsResult {
  const database = ctx.db;
  const cutoff = staleCutoff(ctx, options.now ?? Date.now());

  return database.transaction(() => {
    const expiredQueues = database
      .prepare("SELECT name FROM queues WHERE last_observed_at < ?")
      .all(cutoff) as Array<{ name: string }>;
    const queueNames = expiredQueues.map((row) => row.name);

    let cascadedSchedulers = 0;
    if (queueNames.length > 0) {
      const placeholders = queueNames.map(() => "?").join(",");
      const { n } = database
        .prepare(`SELECT COUNT(*) as n FROM schedulers WHERE queue IN (${placeholders})`)
        .get(...queueNames) as { n: number };
      cascadedSchedulers = n;
      database
        .prepare(`DELETE FROM schedulers WHERE queue IN (${placeholders})`)
        .run(...queueNames);
      database.prepare(`DELETE FROM queues WHERE name IN (${placeholders})`).run(...queueNames);
    }

    const { n: staleSchedulers } = database
      .prepare("SELECT COUNT(*) as n FROM schedulers WHERE last_observed_at < ?")
      .get(cutoff) as { n: number };
    if (staleSchedulers > 0) {
      database.prepare("DELETE FROM schedulers WHERE last_observed_at < ?").run(cutoff);
    }

    const { n: staleJobs } = database
      .prepare("SELECT COUNT(*) as n FROM jobs WHERE last_observed_at < ?")
      .get(cutoff) as { n: number };
    if (staleJobs > 0) {
      database.prepare("DELETE FROM jobs WHERE last_observed_at < ?").run(cutoff);
    }

    return {
      queuesDeleted: queueNames.length,
      schedulersDeleted: cascadedSchedulers + staleSchedulers,
      jobsDeleted: staleJobs,
    };
  })();
}

function dimensionState(
  ctx: Context,
  table: "jobs" | "schedulers",
  queue: string,
  cutoff: number,
): CacheDimensionState {
  const row = ctx.db
    .prepare(
      `
      SELECT
        COUNT(*) as count,
        SUM(CASE WHEN last_observed_at < ? THEN 1 ELSE 0 END) as stale_count,
        MIN(last_observed_at) as oldest_observed_at,
        MAX(last_observed_at) as newest_observed_at
      FROM ${table}
      WHERE queue = ?
    `,
    )
    .get(cutoff, queue) as {
    count: number;
    stale_count: number | null;
    oldest_observed_at: number | null;
    newest_observed_at: number | null;
  };

  return {
    count: row.count,
    staleCount: row.stale_count ?? 0,
    oldestObservedAt: row.oldest_observed_at,
    newestObservedAt: row.newest_observed_at,
  };
}

export function getCacheState(ctx: Context, queue: string): QueueCacheState {
  const now = Date.now();
  const cutoff = staleCutoff(ctx, now);
  const queueRow = ctx.db
    .prepare("SELECT last_observed_at FROM queues WHERE name = ?")
    .get(queue) as { last_observed_at: number } | null;

  return {
    cacheTtlMs: ctx.config.cacheTtlMs,
    queue: {
      exists: queueRow !== null,
      lastObservedAt: queueRow?.last_observed_at ?? null,
      isStale: queueRow ? queueRow.last_observed_at < cutoff : false,
    },
    jobs: dimensionState(ctx, "jobs", queue, cutoff),
    schedulers: dimensionState(ctx, "schedulers", queue, cutoff),
  };
}
