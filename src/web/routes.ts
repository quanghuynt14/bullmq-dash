import { getAllQueueStats } from "../data/queues.js";
import { getJobDetail, getJobs } from "../data/jobs.js";
import { getAllJobSchedulers, getJobSchedulerDetail } from "../data/schedulers.js";
import { getGlobalMetrics } from "../data/metrics.js";
import { queryJobs, getQueueJobCount } from "./sqlite.js";

export async function handleQueuesList(): Promise<Response> {
  const queues = await getAllQueueStats();
  return Response.json({ timestamp: new Date().toISOString(), queues });
}

export async function handleJobsList(queueName: string, url: URL): Promise<Response> {
  const search = url.searchParams.get("q") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const sort = url.searchParams.get("sort") ?? "timestamp";
  const order = (url.searchParams.get("order") ?? "desc") as "asc" | "desc";
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = parseInt(url.searchParams.get("pageSize") ?? "25", 10);

  // Fallback to Redis if SQLite has no data for this queue (still indexing)
  if (!search && getQueueJobCount(queueName) === 0) {
    const statusMap: Record<string, string> = { waiting: "wait", active: "active", completed: "completed", failed: "failed", delayed: "delayed" };
    const redisStatus = (state && state !== "all") ? (statusMap[state] ?? "latest") as "wait" | "active" | "completed" | "failed" | "delayed" | "latest" : "latest";
    const result = await getJobs(queueName, redisStatus, isNaN(page) ? 1 : page, isNaN(pageSize) ? 25 : Math.min(pageSize, 100));
    return Response.json({
      timestamp: new Date().toISOString(),
      queue: queueName,
      jobs: result.jobs.map((j) => ({ ...j, queue: queueName, data_preview: null })),
      total: result.total,
    });
  }

  const result = queryJobs({
    queue: queueName,
    search,
    state,
    sort,
    order,
    page: isNaN(page) ? 1 : page,
    pageSize: isNaN(pageSize) ? 25 : Math.min(pageSize, 100),
  });

  return Response.json({
    timestamp: new Date().toISOString(),
    queue: queueName,
    ...result,
  });
}

export async function handleJobDetail(queueName: string, jobId: string): Promise<Response> {
  const job = await getJobDetail(queueName, jobId);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  return Response.json({
    timestamp: new Date().toISOString(),
    queue: queueName,
    job,
  });
}

export async function handleSchedulersList(queueName: string): Promise<Response> {
  const schedulers = await getAllJobSchedulers(queueName);
  return Response.json({
    timestamp: new Date().toISOString(),
    queue: queueName,
    schedulers,
  });
}

export async function handleSchedulerDetail(
  queueName: string,
  schedulerKey: string,
): Promise<Response> {
  const scheduler = await getJobSchedulerDetail(queueName, schedulerKey);
  if (!scheduler) {
    return Response.json({ error: "Scheduler not found" }, { status: 404 });
  }
  return Response.json({
    timestamp: new Date().toISOString(),
    queue: queueName,
    scheduler,
  });
}

export async function handleMetrics(): Promise<Response> {
  const metrics = await getGlobalMetrics();
  return Response.json({
    timestamp: new Date().toISOString(),
    metrics,
  });
}

export function handleNotFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}
