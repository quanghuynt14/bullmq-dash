import { Queue } from "bullmq";
import type { Context } from "../context.js";

// Queue names cache with TTL.
// Module-level rather than per-context: it's a short-lived (5s) observation
// of a Redis-side fact (the set of queues for this prefix), not derived from
// context-specific state. Sharing across contexts in the same process is
// fine; tests that need isolation create distinct prefixes.
let queueNamesCache: {
  names: string[];
  timestamp: number;
} | null = null;

const QUEUE_NAMES_CACHE_TTL = 5000; // 5 seconds
const SCAN_COUNT = 1000;
const DEL_BATCH_SIZE = 500;

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
 * Get or create a BullMQ Queue instance, memoised per-Context.
 */
export function getQueue(ctx: Context, queueName: string): Queue {
  const cached = ctx.queueCache.get(queueName);
  if (cached) return cached;

  const queue = new Queue(queueName, {
    prefix: ctx.config.prefix,
    connection: {
      host: ctx.config.redis.host,
      port: ctx.config.redis.port,
      username: ctx.config.redis.username,
      password: ctx.config.redis.password,
      db: ctx.config.redis.db,
      ...(ctx.config.redis.tls ? { tls: {} } : {}),
    },
  });
  ctx.queueCache.set(queueName, queue);
  return queue;
}

/**
 * Discover all queue names from Redis
 */
export async function discoverQueueNames(ctx: Context): Promise<string[]> {
  // Use configured queue names if provided
  if (ctx.config.queueNames && ctx.config.queueNames.length > 0) {
    return ctx.config.queueNames;
  }

  const now = Date.now();

  // Return cached names if fresh
  if (queueNamesCache && now - queueNamesCache.timestamp < QUEUE_NAMES_CACHE_TTL) {
    return queueNamesCache.names;
  }

  const queueNames = new Set<string>();
  const prefix = ctx.config.prefix + ":";

  let cursor = "0";
  do {
    // Sequential by necessity: each SCAN call returns the cursor for the
    // next call. Can't parallelize a cursor-based Redis scan.
    // eslint-disable-next-line no-await-in-loop
    const [nextCursor, keys] = await ctx.redis.scan(
      cursor,
      "MATCH",
      `${ctx.config.prefix}:*`,
      "COUNT",
      SCAN_COUNT,
    );
    cursor = nextCursor;

    for (const key of keys) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const colonIdx = rest.indexOf(":");
        const queueName = colonIdx === -1 ? rest : rest.slice(0, colonIdx);
        if (queueName) {
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
export async function getQueueStats(ctx: Context, queueName: string): Promise<QueueStats> {
  const queue = getQueue(ctx, queueName);

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
export async function getAllQueueStats(ctx: Context): Promise<QueueStats[]> {
  const queueNames = await discoverQueueNames(ctx);

  const stats = await Promise.all(queueNames.map((name) => getQueueStats(ctx, name)));

  return stats;
}

/**
 * Close all queue connections
 */
export async function closeAllQueues(ctx: Context): Promise<void> {
  const closePromises = Array.from(ctx.queueCache.values()).map((queue) => queue.close());
  await Promise.all(closePromises);
  ctx.queueCache.clear();
  queueNamesCache = null;
}

export interface DeleteQueueResult {
  name: string;
  counts: {
    wait: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

export async function deleteQueue(
  ctx: Context,
  queueName: string,
  dryRun: boolean = false,
): Promise<DeleteQueueResult> {
  const queue = getQueue(ctx, queueName);

  const counts = await queue.getJobCounts();

  const result: DeleteQueueResult = {
    name: queueName,
    counts: {
      wait: (counts.waiting || 0) + (counts.prioritized || 0),
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
    },
  };

  if (!dryRun) {
    await queue.obliterate({ force: true });

    const escapedQueueName = queueName.replace(/[[*?]/g, "\\$&");
    const repeatKeyPattern = `${ctx.config.prefix}:${escapedQueueName}:*`;

    const allKeys: string[] = [];
    let cursor = "0";
    do {
      // eslint-disable-next-line no-await-in-loop
      const [nextCursor, keys] = await ctx.redis.scan(
        cursor,
        "MATCH",
        repeatKeyPattern,
        "COUNT",
        SCAN_COUNT,
      );
      cursor = nextCursor;
      allKeys.push(...keys);
    } while (cursor !== "0");

    if (allKeys.length > 0) {
      for (let i = 0; i < allKeys.length; i += DEL_BATCH_SIZE) {
        const batch = allKeys.slice(i, i + DEL_BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop
        await ctx.redis.del(...batch);
      }
    }

    await queue.close();
    ctx.queueCache.delete(queueName);
    if (queueNamesCache) {
      queueNamesCache.names = queueNamesCache.names.filter((n) => n !== queueName);
    }
  }

  return result;
}
