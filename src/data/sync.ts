import type { Database } from "bun:sqlite";
import { getAllJobIds } from "./jobs.js";
import { discoverQueueNames } from "./queues.js";
import {
  createSyncStaging,
  insertStagingBatch,
  findNewIdsByStagingDiff,
  findChangedIdsByStagingDiff,
  findStaleIdsByStagingDiff,
  deleteJobsByIds,
  dropSyncStaging,
  getSqliteDb,
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
 *
 * `syncLockAcquiredAt` lets us steal a stuck lock if the holding sync hung
 * past SYNC_LOCK_TIMEOUT_MS (e.g., a never-resolving promise bypassed the
 * finally). Without this, one stuck sync would refuse every future sync for
 * the lifetime of the process with no way to recover.
 */
let syncInProgress = false;
let syncLockAcquiredAt: number | null = null;
const SYNC_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function tryAcquireSyncLock(): { ok: true } | { ok: false; heldForMs: number } {
  if (syncInProgress && syncLockAcquiredAt !== null) {
    const heldForMs = Date.now() - syncLockAcquiredAt;
    if (heldForMs <= SYNC_LOCK_TIMEOUT_MS) {
      return { ok: false, heldForMs };
    }
    console.error(
      `Sync lock held for ${heldForMs}ms (> ${SYNC_LOCK_TIMEOUT_MS}ms timeout) — stealing.`,
    );
  }
  syncInProgress = true;
  syncLockAcquiredAt = Date.now();
  return { ok: true };
}

function releaseSyncLock(): void {
  syncInProgress = false;
  syncLockAcquiredAt = null;
}

/** Test-only helper: reset the sync lock between tests. */
export function __resetSyncLockForTests(): void {
  releaseSyncLock();
}

/**
 * Test-only helper: force the sync lock into a "held since `acquiredAtMs`"
 * state so the next caller can exercise the stale-lock stealing path.
 */
export function __forceSyncLockForTests(acquiredAtMs: number): void {
  syncInProgress = true;
  syncLockAcquiredAt = acquiredAtMs;
}

/**
 * Tracks recent polling writes so background sync doesn't overwrite state
 * that polling (3s interval) refreshed while sync's staging snapshot (60s
 * interval) was stale.
 *
 * Key: `${queue}:${id}`. Value: Date.now() of the polling write. Entries
 * live for RECENT_POLL_WINDOW_MS then get pruned opportunistically. The cap
 * prevents unbounded growth on very busy queues.
 */
const recentlyPolledWrites = new Map<string, number>();
const RECENT_POLL_WINDOW_MS = 120_000;
const RECENT_POLL_MAX_ENTRIES = 50_000;

function pruneRecentlyPolled(): void {
  const cutoff = Date.now() - RECENT_POLL_WINDOW_MS;
  for (const [key, ts] of recentlyPolledWrites) {
    if (ts < cutoff) recentlyPolledWrites.delete(key);
  }
}

/**
 * Notify the sync layer that polling just wrote fresh state for these jobs.
 * Sync's next diff will skip state overwrite and stale-delete for them until
 * either RECENT_POLL_WINDOW_MS elapses or the next polling write replaces the
 * timestamp.
 */
export function markPolledWrites(queue: string, jobIds: readonly string[]): void {
  const now = Date.now();
  for (const id of jobIds) {
    recentlyPolledWrites.set(`${queue}:${id}`, now);
  }
  if (recentlyPolledWrites.size > RECENT_POLL_MAX_ENTRIES) {
    pruneRecentlyPolled();
  }
}

/** Test-only helper: reset the recently-polled map between tests. */
export function __resetRecentlyPolledForTests(): void {
  recentlyPolledWrites.clear();
}

function wasPolledSince(queue: string, jobId: string, threshold: number): boolean {
  const ts = recentlyPolledWrites.get(`${queue}:${jobId}`);
  return ts !== undefined && ts >= threshold;
}

/**
 * Sync a single queue from Redis to SQLite — incrementally at scale.
 *
 * Uses a staging table for SQL-side diffing:
 * 1. Paginate all job IDs from Redis into staging (5000 at a time)
 * 2. SQL JOIN to find new IDs → insert as stubs (id + state, no data)
 * 3. SQL JOIN to find changed states → update state only
 *    (skip IDs polling refreshed after sync started — staging is stale for those)
 * 4. SQL LEFT JOIN to find stale IDs → delete
 *    (same exclusion — polling may have just inserted a job sync's snapshot missed)
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
  const lock = tryAcquireSyncLock();
  if (!lock.ok) {
    const message =
      `Refusing to sync queue "${queueName}": another sync is in progress ` +
      `(held ${lock.heldForMs}ms). syncQueue/fullSync share a single staging ` +
      `table and cannot run concurrently.`;
    console.error(message);
    return {
      inserted: 0,
      stateUpdated: 0,
      deleted: 0,
      total: 0,
      error: message,
    };
  }

  // Capture BEFORE staging population. Any polling write after this timestamp
  // is provably not reflected in staging (polling pulls from Redis live;
  // staging is a snapshot taken starting now). Conservatively skip those.
  const syncStart = Date.now();
  // Snapshot the connection so we can detect a closeSqliteDb() mid-sync and
  // abort with a clear error instead of a confusing "no such table" from
  // operating on a fresh connection that never saw CREATE TEMP sync_staging.
  const syncDb: Database = getSqliteDb();
  const assertSameConnection = () => {
    if (getSqliteDb() !== syncDb) {
      throw new Error(
        `syncQueue("${queueName}") aborted: SQLite connection was closed mid-sync`,
      );
    }
  };
  try {
    createSyncStaging();

    // Step 1: Paginate all IDs from Redis into staging
    let total = 0;
    for await (const batch of getAllJobIds(queueName)) {
      assertSameConnection();
      insertStagingBatch(queueName, batch);
      total += batch.length;
    }

    assertSameConnection();

    // Step 2: Find and insert new jobs as stubs.
    // findNewIdsByStagingDiff returns id + state, so we can hand the rows
    // straight to upsertJobStubs without a second round-trip.
    const newStubs = findNewIdsByStagingDiff(queueName);
    if (newStubs.length > 0) {
      upsertJobStubs(queueName, newStubs);
    }

    // Step 3: Find and update changed states — but skip jobs polling
    // refreshed after we started, because staging's state for them is stale.
    const changed = findChangedIdsByStagingDiff(queueName).filter(
      (row) => !wasPolledSince(queueName, row.id, syncStart),
    );
    if (changed.length > 0) {
      upsertJobStubs(queueName, changed);
    }

    // Step 4: Delete stale jobs — same exclusion. A job polling inserted
    // between syncStart and now isn't in staging (we built staging from a
    // Redis snapshot that predated the insert), so the anti-join would
    // misclassify it as stale and delete it.
    const staleIds = findStaleIdsByStagingDiff(queueName).filter(
      (id) => !wasPolledSince(queueName, id, syncStart),
    );
    const deleted = deleteJobsByIds(queueName, staleIds);

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
    // Skip dropSyncStaging if the connection was swapped — the old connection
    // is closed (DROP would throw), and the new connection's TEMP staging
    // never existed.
    if (getSqliteDb() === syncDb) {
      try {
        dropSyncStaging();
      } catch (cleanupError) {
        console.error(
          `Failed to drop sync_staging for queue "${queueName}":`,
          cleanupError,
        );
      }
    }
    releaseSyncLock();
  }
}

export interface FullSyncResult {
  queues: number;
  totalInserted: number;
  totalDeleted: number;
  /** Per-queue failures. Empty array means every queue succeeded. */
  errors: Array<{ queue: string; error: string }>;
}

/**
 * Full sync: discover all queues and sync each one sequentially.
 *
 * Sequential because they share the same staging table. Each queue
 * creates/drops the staging table in its own syncQueue() call.
 *
 * Per-queue failures are collected into `errors` rather than aborting the
 * whole sync. A non-empty `errors` array with `queues > 0` means partial
 * success; `queues: 0` with `errors: [{queue: "", ...}]` means discovery
 * itself failed.
 */
export async function fullSync(): Promise<FullSyncResult> {
  let queues: string[];
  try {
    queues = await discoverQueueNames();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("SQLite full sync: queue discovery failed:", error);
    return {
      queues: 0,
      totalInserted: 0,
      totalDeleted: 0,
      errors: [{ queue: "", error: message }],
    };
  }

  let totalInserted = 0;
  let totalDeleted = 0;
  const errors: Array<{ queue: string; error: string }> = [];

  for (const q of queues) {
    // Sequential by design: queues share the single sync_staging TEMP table
    // on the shared SQLite connection. Parallelizing would corrupt the diff.
    // eslint-disable-next-line no-await-in-loop
    const result = await syncQueue(q);
    if (result.error) {
      errors.push({ queue: q, error: result.error });
    } else {
      totalInserted += result.inserted;
      totalDeleted += result.deleted;
    }
  }

  return { queues: queues.length, totalInserted, totalDeleted, errors };
}
