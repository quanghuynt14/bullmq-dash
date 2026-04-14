import { getAllJobs } from "./jobs.js";
import { discoverQueueNames } from "./queues.js";
import { upsertJobs, deleteStaleJobs } from "./sqlite.js";

const DEFAULT_MAX_SYNC_JOBS = 10_000;

/**
 * Sync a single queue from Redis to SQLite.
 *
 * Fetches all jobs, upserts them into SQLite, then deletes stale entries
 * that no longer exist in Redis. The deleteStaleJobs call is the P0 fix —
 * without it, jobs that are removed from Redis accumulate as ghost rows.
 */
export async function syncQueue(
  queueName: string,
  maxResults: number = DEFAULT_MAX_SYNC_JOBS,
): Promise<{ upserted: number; deleted: number }> {
  try {
    const result = await getAllJobs(queueName, undefined, maxResults);

    const rows = result.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      state: j.state,
      timestamp: j.timestamp,
    }));

    // Batch upsert all jobs at once (not one-at-a-time like the old code)
    if (rows.length > 0) {
      upsertJobs(queueName, rows);
    }

    // P0 fix: delete stale jobs that no longer exist in Redis
    const activeIds = rows.map((r) => r.id);
    const deleted = deleteStaleJobs(queueName, activeIds);

    return { upserted: rows.length, deleted };
  } catch (error) {
    console.error(`SQLite sync failed for queue "${queueName}":`, error);
    return { upserted: 0, deleted: 0 };
  }
}

/**
 * Full sync: discover all queues and sync each one.
 *
 * Uses Promise.allSettled so one queue failure doesn't block the others.
 */
export async function fullSync(
  maxResultsPerQueue: number = DEFAULT_MAX_SYNC_JOBS,
): Promise<{ queues: number; totalUpserted: number; totalDeleted: number }> {
  try {
    const queues = await discoverQueueNames();
    const results = await Promise.allSettled(
      queues.map((q) => syncQueue(q, maxResultsPerQueue)),
    );

    let totalUpserted = 0;
    let totalDeleted = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        totalUpserted += result.value.upserted;
        totalDeleted += result.value.deleted;
      }
    }

    return { queues: queues.length, totalUpserted, totalDeleted };
  } catch (error) {
    console.error("SQLite full sync failed:", error);
    return { queues: 0, totalUpserted: 0, totalDeleted: 0 };
  }
}
