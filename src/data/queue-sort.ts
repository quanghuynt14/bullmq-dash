import type { QueueStats } from "./queues.js";

export type QueueSortBy =
  | "name"
  | "task-size"
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed";
export type SortOrder = "asc" | "desc";

export const QUEUE_SORT_FIELDS: QueueSortBy[] = [
  "name",
  "task-size",
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
];

export function queueSortLabel(sortBy: QueueSortBy, order: SortOrder): string {
  const label = sortBy === "task-size" ? "size" : sortBy;
  return `${label} ${order}`;
}

function metric(queue: QueueStats, sortBy: QueueSortBy): string | number {
  switch (sortBy) {
    case "name":
      return queue.name;
    case "task-size":
      return queue.total;
    case "waiting":
      return queue.counts.wait;
    case "active":
      return queue.counts.active;
    case "completed":
      return queue.counts.completed;
    case "failed":
      return queue.counts.failed;
    case "delayed":
      return queue.counts.delayed;
  }
}

export function defaultSortOrder(sortBy: QueueSortBy): SortOrder {
  return sortBy === "name" ? "asc" : "desc";
}

export function sortQueues(
  queues: QueueStats[],
  sortBy: QueueSortBy = "name",
  order: SortOrder = defaultSortOrder(sortBy),
): QueueStats[] {
  const direction = order === "asc" ? 1 : -1;

  return queues.toSorted((a, b) => {
    const aMetric = metric(a, sortBy);
    const bMetric = metric(b, sortBy);

    if (typeof aMetric === "number" && typeof bMetric === "number") {
      const diff = aMetric - bMetric;
      if (diff !== 0) return diff * direction;
      return a.name.localeCompare(b.name);
    }

    return String(aMetric).localeCompare(String(bMetric)) * direction;
  });
}
