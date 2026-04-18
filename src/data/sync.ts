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
} from "./sqlite.js";

export interface SyncResult {
  inserted: number;
  stateUpdated: number;
  deleted: number;
  total: number;
  /** Set when the sync failed; callers can use this to surface the error. */
  error?: string;
}

/**
 * Module-level guard: only one sync may run at a time.
 *
 * The shared `sync_staging` TEMP table is per-connection and we use a single
 * shared SQLite connection (see getSqliteDb), so two concurrent syncs would
 * stomp on each other's staging rows. We fail fast rather than corrupt data.
 */
let syncInProgress = false;

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
 *
 * **Concurrency:** NOT parallel-safe. The `sync_staging` TEMP table is
 * shared across the single SQLite connection, so concurrent calls to
 * `syncQueue` (or `fullSync`) would interleave staging rows and corrupt
 * the diff. A module-level guard rejects overlapping calls.
 *
 * **Failure recovery:** there is no partial-progress checkpoint. If a sync
 * fails mid-way (Redis disconnect, SQLite error, process killed), the
 * staging table is dropped and the next run starts from scratch. Already-
 * persisted jobs are preserved; the next successful sync will reconcile.
 */
export async function syncQueue(queueName: string): Promise<SyncResult> {
  if (syncInProgress) {
    const message =
      `Refusing to sync queue "${queueName}": another sync is already in progress. ` +
      `syncQueue/fullSync share a single staging table and cannot run concurrently.`;
    console.error(message);
    return {
      inserted: 0,
      stateUpdated: 0,
      deleted: 0,
      total: 0,
      error: message,
    };
  }

  syncInProgress = true;
  try {
    createSyncStaging();

    // Step 1: Paginate all IDs from Redis into staging
    let total = 0;
    for await (const batch of getAllJobIds(queueName)) {
      insertStagingBatch(queueName, batch);
      total += batch.length;
    }

    // Step 2: Find and insert new jobs as stubs.
    // findNewIdsByStagingDiff returns id + state, so we can hand the rows
    // straight to upsertJobStubs without a second round-trip.
    const newStubs = findNewIdsByStagingDiff(queueName);
    if (newStubs.length > 0) {
      upsertJobStubs(queueName, newStubs);
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

    return {
      inserted: newStubs.length,
      stateUpdated: changed.length,
      deleted,
      total,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`SQLite sync failed for queue "${queueName}":`, error);
    return {
      inserted: 0,
      stateUpdated: 0,
      deleted: 0,
      total: 0,
      error: message,
    };
  } finally {
    try {
      dropSyncStaging();
    } catch {
      // ignore cleanup errors
    }
    syncInProgress = false;
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
