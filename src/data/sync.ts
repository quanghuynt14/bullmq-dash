import { getAllJobIds } from "./jobs.js";
import { discoverQueueNames } from "./queues.js";
import {
  createSyncStaging,
  insertStagingBatch,
  findNewIdsByStagingDiff,
  findChangedIdsByStagingDiff,
  deleteStaleByStagingDiff,
  dropSyncStaging,
  upsertJobStubs,
  upsertSyncState,
  getSqliteDb,
} from "./sqlite.js";

export interface SyncResult {
  inserted: number;
  stateUpdated: number;
  deleted: number;
  total: number;
}

/**
 * Sync a single queue from Redis to SQLite — incrementally at scale.
 *
 * Uses a staging table for SQL-side diffing:
 * 1. Paginate all job IDs from Redis into staging (5000 at a time)
 * 2. SQL JOIN to find new IDs → insert as stubs (id + state, no data)
 * 3. SQL JOIN to find changed states → update state only
 * 4. SQL LEFT JOIN to find stale IDs → delete
 * 5. Update sync_state metadata
 *
 * Name, timestamp, and data_preview are populated lazily when jobs are
 * viewed in TUI or fetched via CLI — not during background sync.
 */
export async function syncQueue(queueName: string): Promise<SyncResult> {
  try {
    createSyncStaging();

    // Step 1: Paginate all IDs from Redis into staging
    let total = 0;
    for await (const batch of getAllJobIds(queueName)) {
      insertStagingBatch(queueName, batch);
      total += batch.length;
    }

    // Step 2: Find and insert new jobs as stubs
    const newIds = findNewIdsByStagingDiff(queueName);
    if (newIds.length > 0) {
      // Look up the state for each new ID from staging
      const database = getSqliteDb();
      const BATCH = 900;
      const stubs: Array<{ id: string; state: string }> = [];

      for (let i = 0; i < newIds.length; i += BATCH) {
        const chunk = newIds.slice(i, i + BATCH);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = database.prepare(
          `SELECT id, state FROM sync_staging WHERE queue = ? AND id IN (${placeholders})`,
        ).all(queueName, ...chunk) as Array<{ id: string; state: string }>;
        stubs.push(...rows);
      }

      upsertJobStubs(queueName, stubs);
    }

    // Step 3: Find and update changed states
    const changed = findChangedIdsByStagingDiff(queueName);
    if (changed.length > 0) {
      upsertJobStubs(queueName, changed);
    }

    // Step 4: Delete stale jobs
    const deleted = deleteStaleByStagingDiff(queueName);

    // Step 5: Update sync state
    upsertSyncState(queueName, {
      jobCount: total,
      syncedAt: Date.now(),
    });

    dropSyncStaging();

    return {
      inserted: newIds.length,
      stateUpdated: changed.length,
      deleted,
      total,
    };
  } catch (error) {
    console.error(`SQLite sync failed for queue "${queueName}":`, error);
    try {
      dropSyncStaging();
    } catch {
      // ignore cleanup errors
    }
    return { inserted: 0, stateUpdated: 0, deleted: 0, total: 0 };
  }
}

/**
 * Full sync: discover all queues and sync each one sequentially.
 *
 * Sequential because they share the same staging table. Each queue
 * creates/drops the staging table in its own syncQueue() call.
 */
export async function fullSync(): Promise<{
  queues: number;
  totalInserted: number;
  totalDeleted: number;
}> {
  try {
    const queues = await discoverQueueNames();

    let totalInserted = 0;
    let totalDeleted = 0;

    for (const q of queues) {
      const result = await syncQueue(q);
      totalInserted += result.inserted;
      totalDeleted += result.deleted;
    }

    return { queues: queues.length, totalInserted, totalDeleted };
  } catch (error) {
    console.error("SQLite full sync failed:", error);
    return { queues: 0, totalInserted: 0, totalDeleted: 0 };
  }
}
