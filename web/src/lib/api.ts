import type { QueueStats, JobRow, JobDetail, GlobalMetrics } from "./types";

const BASE = "/api";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function getQueues(): Promise<{ queues: QueueStats[] }> {
  return fetchJson(`${BASE}/queues`);
}

export async function getJobs(
  queue: string,
  params: {
    q?: string;
    state?: string;
    sort?: string;
    order?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ jobs: JobRow[]; total: number }> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.state && params.state !== "all") query.set("state", params.state);
  if (params.sort) query.set("sort", params.sort);
  if (params.order) query.set("order", params.order);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));

  return fetchJson(`${BASE}/queues/${encodeURIComponent(queue)}/jobs?${query}`);
}

export async function getJobDetail(
  queue: string,
  jobId: string,
): Promise<{ job: JobDetail }> {
  return fetchJson(
    `${BASE}/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}`,
  );
}

export async function getMetrics(): Promise<{ metrics: GlobalMetrics }> {
  return fetchJson(`${BASE}/metrics`);
}
