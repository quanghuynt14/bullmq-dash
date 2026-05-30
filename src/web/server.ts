import { closeContext, type Context } from "../context.js";
import { discoverQueueNames, getQueueStats, type QueueStats } from "../data/queues.js";
import {
  getAllJobs,
  getJobDetail,
  retryFailedJobs,
  VALID_JOB_STATUSES,
  type JsonJobStatus,
} from "../data/jobs.js";
import { calculateGlobalMetricsFromQueueStats } from "../data/metrics.js";
import { recordObservedJobs, recordObservedQueues } from "../data/queue-store.js";
import { runQueueStoreCleanupIfDue } from "../data/queue-store-lifecycle.js";
import {
  defaultSortOrder,
  sortQueues,
  type QueueSortBy,
  type SortOrder,
} from "../data/queue-sort.js";
import { renderWebIndex } from "./html.js";

const WEB_SORT_ALIASES = new Map<string, QueueSortBy>([
  ["name", "name"],
  ["task-size", "task-size"],
  ["size", "task-size"],
  ["total", "task-size"],
  ["waiting", "waiting"],
  ["wait", "waiting"],
  ["active", "active"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["delayed", "delayed"],
]);

const WEB_MAX_PAGE_SIZE = 1000;

class WebInputError extends Error {}

export class WebRedisConnectionError extends Error {}

export interface WebServerOptions {
  host: string;
  port: number;
  readOnly: boolean;
}

export interface WebHandlerOptions {
  readOnly?: boolean;
}

interface RetryRequestBody {
  dryRun?: unknown;
  confirm?: unknown;
  pageSize?: unknown;
}

interface RankedQueue extends Omit<QueueStats, "lastObservedAt"> {
  rank: number;
  rankScore: number;
  rankReason: string;
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(error: string, code: string, status: number, details?: string): Response {
  return jsonResponse({ error, code, details }, status);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function splitPath(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function parseQueueSort(rawValue: string | null): QueueSortBy {
  if (!rawValue) return "task-size";
  const sortBy = WEB_SORT_ALIASES.get(rawValue);
  if (!sortBy) {
    throw new WebInputError(
      "Invalid sortBy. Use name, task-size, waiting, active, completed, failed, or delayed.",
    );
  }
  return sortBy;
}

function parseSortOrder(rawValue: string | null, sortBy: QueueSortBy): SortOrder {
  if (!rawValue) return defaultSortOrder(sortBy);
  if (rawValue === "asc" || rawValue === "desc") return rawValue;
  throw new WebInputError("Invalid sortOrder. Use asc or desc.");
}

function parseJobState(rawValue: string | null): JsonJobStatus | undefined {
  if (!rawValue || rawValue === "all") return undefined;
  if (VALID_JOB_STATUSES.includes(rawValue as JsonJobStatus)) return rawValue as JsonJobStatus;
  throw new WebInputError(`Invalid state. Use all, ${VALID_JOB_STATUSES.join(", ")}.`);
}

function parsePageSize(rawValue: string | null | undefined, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new WebInputError("Invalid pageSize. Use a positive integer.");
  }
  return Math.min(parsed, WEB_MAX_PAGE_SIZE);
}

function rankScore(queue: QueueStats): number {
  return (
    queue.total +
    queue.counts.failed * 10 +
    queue.counts.active * 2 +
    queue.counts.wait +
    queue.counts.schedulers * 0.25
  );
}

function rankReason(queue: QueueStats): string {
  const parts: string[] = [];
  if (queue.counts.failed > 0) parts.push(`${queue.counts.failed} failed`);
  if (queue.counts.active > 0) parts.push(`${queue.counts.active} active`);
  if (queue.counts.wait > 0) parts.push(`${queue.counts.wait} waiting`);
  if (queue.counts.delayed > 0) parts.push(`${queue.counts.delayed} delayed`);
  if (queue.counts.schedulers > 0) parts.push(`${queue.counts.schedulers} schedulers`);
  return parts.length > 0 ? parts.join(" / ") : "idle";
}

function publicQueue(queue: QueueStats, rank: number): RankedQueue {
  return {
    name: queue.name,
    counts: queue.counts,
    isPaused: queue.isPaused,
    total: queue.total,
    rank,
    rankScore: Number(rankScore(queue).toFixed(2)),
    rankReason: rankReason(queue),
  };
}

async function fetchOverview(ctx: Context, url: URL): Promise<Response> {
  const sortBy = parseQueueSort(url.searchParams.get("sortBy"));
  const sortOrder = parseSortOrder(url.searchParams.get("sortOrder"), sortBy);
  const queueNames = await discoverQueueNames(ctx);
  const queues = sortQueues(
    await Promise.all(queueNames.map((name) => getQueueStats(ctx, name))),
    sortBy,
    sortOrder,
  );
  const observedAt = Date.now();
  const zeroRates = {
    enqueuedPerMin: 0,
    enqueuedPerSec: 0,
    dequeuedPerMin: 0,
    dequeuedPerSec: 0,
  };

  try {
    recordObservedQueues(ctx, queues, { observedAt });
  } catch {
    // Cache observations are best-effort; live dashboard data should still render.
  }

  runQueueStoreCleanupIfDue(ctx);

  return jsonResponse({
    timestamp: new Date(observedAt).toISOString(),
    sort: { by: sortBy, order: sortOrder },
    queues: queues.map((queue, index) => publicQueue(queue, index + 1)),
    metrics: calculateGlobalMetricsFromQueueStats(queues, zeroRates),
  });
}

async function fetchJobs(ctx: Context, queueName: string, url: URL): Promise<Response> {
  const state = parseJobState(url.searchParams.get("state"));
  const pageSize = parsePageSize(url.searchParams.get("pageSize"), 100);
  const result = await getAllJobs(ctx, queueName, state, pageSize, false);
  const observedAt = Date.now();

  try {
    recordObservedJobs(ctx, queueName, result.jobs, { observedAt });
  } catch {
    // Cache observations are best-effort; live dashboard data should still render.
  }

  return jsonResponse({
    timestamp: new Date(observedAt).toISOString(),
    queue: queueName,
    jobState: state ?? "all",
    jobs: result.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      state: job.state,
      timestamp: job.timestamp,
    })),
    total: result.total,
  });
}

async function fetchJobDetail(ctx: Context, queueName: string, jobId: string): Promise<Response> {
  const job = await getJobDetail(ctx, queueName, jobId);
  if (!job) {
    return errorResponse("Job not found", "NOT_FOUND", 404);
  }
  const observedAt = Date.now();

  try {
    recordObservedJobs(ctx, queueName, [job], { observedAt });
  } catch {
    // Cache observations are best-effort; live dashboard data should still render.
  }

  return jsonResponse({
    timestamp: new Date(observedAt).toISOString(),
    queue: queueName,
    job,
  });
}

async function parseRetryBody(request: Request): Promise<RetryRequestBody | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return errorResponse("Expected application/json request body", "CONFIG_ERROR", 415);
  }

  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse("Expected a JSON object body", "CONFIG_ERROR", 400);
    }
    return parsed as RetryRequestBody;
  } catch (error) {
    return errorResponse(
      "Invalid JSON request body",
      "CONFIG_ERROR",
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function retryOneJob(
  ctx: Context,
  request: Request,
  queueName: string,
  jobId: string,
  readOnly: boolean,
) {
  const body = await parseRetryBody(request);
  if (body instanceof Response) return body;

  const dryRun = body.dryRun !== false;
  if (readOnly && !dryRun) {
    return errorResponse("Web mode is read-only", "READ_ONLY", 403);
  }
  if (!dryRun && body.confirm !== true) {
    return errorResponse("Live retry requires confirm=true", "CONFIG_ERROR", 409);
  }

  const result = await retryFailedJobs(ctx, queueName, {
    jobId,
    dryRun,
  });

  return jsonResponse({
    timestamp: new Date().toISOString(),
    command: "jobs-retry",
    dryRun,
    queue: queueName,
    filter: { jobState: "failed", jobId },
    ...result,
  });
}

async function retryFailedBatch(
  ctx: Context,
  request: Request,
  queueName: string,
  readOnly: boolean,
) {
  const body = await parseRetryBody(request);
  if (body instanceof Response) return body;

  const dryRun = body.dryRun !== false;
  if (readOnly && !dryRun) {
    return errorResponse("Web mode is read-only", "READ_ONLY", 403);
  }
  if (!dryRun && body.confirm !== true) {
    return errorResponse("Live retry requires confirm=true", "CONFIG_ERROR", 409);
  }

  const result = await retryFailedJobs(ctx, queueName, {
    pageSize: parsePageSize(String(body.pageSize ?? ""), 1000),
    dryRun,
  });

  return jsonResponse({
    timestamp: new Date().toISOString(),
    command: "jobs-retry",
    dryRun,
    queue: queueName,
    filter: { jobState: "failed" },
    ...result,
  });
}

async function routeApi(
  ctx: Context,
  request: Request,
  url: URL,
  segments: string[],
  options: Required<WebHandlerOptions>,
) {
  if (request.method === "GET" && segments.length === 2 && segments[1] === "overview") {
    return fetchOverview(ctx, url);
  }

  if (segments[1] !== "queues" || segments.length < 4) {
    return errorResponse("API route not found", "NOT_FOUND", 404);
  }

  const queueName = segments[2]!;
  const resource = segments[3]!;

  if (request.method === "GET" && resource === "jobs" && segments.length === 4) {
    return fetchJobs(ctx, queueName, url);
  }

  if (request.method === "GET" && resource === "jobs" && segments.length === 5) {
    return fetchJobDetail(ctx, queueName, segments[4]!);
  }

  if (
    request.method === "POST" &&
    resource === "jobs" &&
    segments.length === 6 &&
    segments[5] === "retry"
  ) {
    return retryOneJob(ctx, request, queueName, segments[4]!, options.readOnly);
  }

  if (request.method === "POST" && resource === "retry-failed" && segments.length === 4) {
    return retryFailedBatch(ctx, request, queueName, options.readOnly);
  }

  return errorResponse("API route not found", "NOT_FOUND", 404);
}

export function createWebHandler(
  ctx: Context,
  options: WebHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const handlerOptions: Required<WebHandlerOptions> = {
    readOnly: options.readOnly ?? false,
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const segments = splitPath(url.pathname);
    if (!segments) {
      return errorResponse("Malformed request path", "CONFIG_ERROR", 400);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return htmlResponse(
        renderWebIndex({
          pollIntervalMs: ctx.config.pollInterval,
          prefix: ctx.config.prefix,
          readOnly: handlerOptions.readOnly,
        }),
      );
    }

    if (segments[0] !== "api") {
      return errorResponse("Route not found", "NOT_FOUND", 404);
    }

    try {
      return await routeApi(ctx, request, url, segments, handlerOptions);
    } catch (error) {
      if (error instanceof WebInputError) {
        return errorResponse(error.message, "CONFIG_ERROR", 400);
      }
      return errorResponse(
        "Web request failed",
        "RUNTIME_ERROR",
        500,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

export async function runWebMode(ctx: Context, options: WebServerOptions): Promise<void> {
  try {
    await ctx.redis.connect();
  } catch (error) {
    try {
      await closeContext(ctx);
    } catch {
      // Ignore cleanup errors — the Redis connection failure is the useful signal.
    }
    throw new WebRedisConnectionError(error instanceof Error ? error.message : String(error));
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.host,
      port: options.port,
      fetch: createWebHandler(ctx, { readOnly: options.readOnly }),
    });
  } catch (error) {
    try {
      await closeContext(ctx);
    } catch {
      // Ignore cleanup errors — startup failure details are reported by the caller.
    }
    throw error;
  }

  const displayHost = options.host === "0.0.0.0" ? "localhost" : options.host;
  const mode = options.readOnly ? "read-only" : "live-actions";
  console.log(`bullmq-dash web UI (${mode}): http://${displayHost}:${server.port}`);
  if (!isLoopbackHost(options.host)) {
    console.warn(
      "Warning: web mode has no built-in authentication; expose it only on trusted networks.",
    );
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true);
      closeContext(ctx)
        .catch(() => {})
        .finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
