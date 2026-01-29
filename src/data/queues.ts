import { Queue } from "bullmq";
import { getConfig } from "../config.js";
import { getRedisClient } from "./redis.js";

// Queue cache to reuse connections
const queueCache = new Map<string, Queue>();

// Queue names cache with TTL
let queueNamesCache: {
  names: string[];
  timestamp: number;
} | null = null;

const QUEUE_NAMES_CACHE_TTL = 5000; // 5 seconds
const SCAN_COUNT = 1000;
const PREFIX = "bull:";
const SUFFIX = ":meta";

export interface QueueStats {
  name: string;
  counts: {
    wait: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    schedulers: number;
  };
  isPaused: boolean;
  total: number;
}

/**
 * Get or create a BullMQ Queue instance
 */
export function getQueue(queueName: string): Queue {
  if (!queueCache.has(queueName)) {
    const config = getConfig();
    const queue = new Queue(queueName, {
      connection: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
      },
    });
    queueCache.set(queueName, queue);
  }
  return queueCache.get(queueName)!;
}

/**
 * Discover all queue names from Redis
 */
export async function discoverQueueNames(): Promise<string[]> {
  const config = getConfig();

  // Use configured queue names if provided
  if (config.queueNames && config.queueNames.length > 0) {
    return config.queueNames;
  }

  const now = Date.now();

  // Return cached names if fresh
  if (queueNamesCache && now - queueNamesCache.timestamp < QUEUE_NAMES_CACHE_TTL) {
    return queueNamesCache.names;
  }

  const redis = getRedisClient();
  const queueNames = new Set<string>();

  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "bull:*:meta",
      "COUNT",
      SCAN_COUNT,
    );
    cursor = nextCursor;

    for (const key of keys) {
      if (key.startsWith(PREFIX) && key.endsWith(SUFFIX)) {
        const queueName = key.slice(PREFIX.length, key.length - SUFFIX.length);
        if (queueName && !queueName.includes(":")) {
          queueNames.add(queueName);
        }
      }
    }
  } while (cursor !== "0");

  const sortedNames = Array.from(queueNames).toSorted();

  queueNamesCache = {
    names: sortedNames,
    timestamp: now,
  };

  return sortedNames;
}

/**
 * Get stats for a single queue
 */
export async function getQueueStats(queueName: string): Promise<QueueStats> {
  const queue = getQueue(queueName);

  const [counts, isPaused, schedulersCount] = await Promise.all([
    queue.getJobCounts(),
    queue.isPaused(),
    queue.getJobSchedulersCount(),
  ]);

  // Use prioritized count from getJobCounts() instead of fetching all prioritized jobs
  const waitCount = (counts.waiting || 0) + (counts.prioritized || 0);

  return {
    name: queueName,
    counts: {
      wait: waitCount,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      schedulers: schedulersCount || 0,
    },
    isPaused,
    total:
      waitCount +
      (counts.active || 0) +
      (counts.completed || 0) +
      (counts.failed || 0) +
      (counts.delayed || 0),
  };
}

/**
 * Get stats for all discovered queues
 */
export async function getAllQueueStats(): Promise<QueueStats[]> {
  const queueNames = await discoverQueueNames();

  const stats = await Promise.all(queueNames.map((name) => getQueueStats(name)));

  return stats;
}

/**
 * Close all queue connections
 */
export async function closeAllQueues(): Promise<void> {
  const closePromises = Array.from(queueCache.values()).map((queue) => queue.close());
  await Promise.all(closePromises);
  queueCache.clear();
  queueNamesCache = null;
}
