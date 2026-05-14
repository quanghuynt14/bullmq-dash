import type { Database } from "bun:sqlite";
import type { Context } from "../context.js";
import { getAllJobIds } from "./jobs.js";
import { discoverQueueNames } from "./queues.js";
import {
  compactRemovedJobs,
  createSyncStaging,
  insertStagingBatch,
  findNewIdsByStagingDiff,
  findChangedIdsByStagingDiff,
  findResurrectedIdsByStagingDiff,
  findStaleIdsByStagingDiff,
  dropSyncStaging,
  softDeleteJobsByIds,
  upsertJobStubs,
  upsertSyncState,
} from "./sqlite.js";

export interface SyncResult {
  inserted: number;
  stateUpdated: number;
  /** Rows newly stamped with `removed_at` because they vanished from Redis. */
  softDeleted: number;
  total: number;
  /** Set when the sync failed; callers can use this to surface the error. */
  error?: string;
}

/**
 * Module-level guard: only one sync may run at a time.
 *
 * The shared `sync_staging` TEMP table is per-connection and we use a single
 * shared SQLite connection (`ctx.db`), so two concurrent syncs would
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

class JobResurrectionError extends Error {
  constructor(queueName: string, ids: string[]) {
    super(
      `Resurrected job IDs detected in queue "${queueName}": ` +
        `${ids.join(", ")}. ` +
        `Soft-deleted IDs are not allowed to reappear in Redis.`,
    );
    this.name = "JobResurrectionError";
  }
}

class FullSyncInvariantError extends Error {
  constructor(readonly errors: Array<{ queue: string; error: string }>) {
    super(
      `SQLite full sync invariant violation in ${errors.length} queue(s): ` +
        errors.map((e) => `${e.queue}: ${e.error}`).join("; "),
    );
    this.name = "FullSyncInvariantError";
  }
}

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
 * 2. Resurrection check — staging IDs that exist as soft-deleted rows in
 *    jobs are an invariant violation; throw with the queue + offending IDs.
 * 3. SQL JOIN to find new IDs → insert as stubs (id + state, no data)
 * 4. SQL JOIN to find changed states (live rows only) → update state only
 *    (skip IDs polling refreshed after sync started — staging is stale for those)
 * 5. SQL LEFT JOIN to find stale live IDs → soft-delete (`removed_at = now`)
 *    (same exclusion — polling may have just inserted a job sync's snapshot missed)
 * 6. Update sync_state metadata
 *
 * Compaction (physical purge of soft-deleted rows past the retention window)
 * runs once per `fullSync`, not per queue — it scans `jobs` globally so
 * doing it inside `syncQueue` would re-scan the same rows N times per cycle.
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
 *
 * @throws JobResurrectionError when Redis contains a job ID that SQLite has
 * already soft-deleted. This is an invariant violation, not an operational
 * sync failure, so it rejects instead of returning `SyncResult.error`.
 */
export async function syncQueue(ctx: Context, queueName: string): Promise<SyncResult> {
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
      softDeleted: 0,
      total: 0,
      error: message,
    };
  }

  // Capture BEFORE staging population. Any polling write after this timestamp
  // is provably not reflected in staging (polling pulls from Redis live;
  // staging is a snapshot taken starting now). Conservatively skip those.
  const syncStart = Date.now();
  // Snapshot the connection so we can detect a ctx.db swap (or close) mid-sync and
  // abort with a clear error instead of a confusing "no such table" from
  // operating on a fresh connection that never saw CREATE TEMP sync_staging.
  const syncDb: Database = ctx.db;
  const assertSameConnection = () => {
    if (ctx.db !== syncDb) {
      throw new Error(`syncQueue("${queueName}") aborted: SQLite connection was closed mid-sync`);
    }
  };
  try {
    createSyncStaging(ctx);

    // Step 1: Paginate all IDs from Redis into staging
    let total = 0;
    for await (const batch of getAllJobIds(ctx, queueName)) {
      assertSameConnection();
      insertStagingBatch(ctx, queueName, batch);
      total += batch.length;
    }

    assertSameConnection();

    // Step 2: Resurrection check. BullMQ job IDs are treated as monotonic
    // (ADR-0001), so a soft-deleted ID reappearing in Redis is an invariant
    // violation, not a reinstatement. Throw loudly with the queue + the
    // offending ids so operators see the violation in logs and downstream
    // assumptions (history view, compaction) don't get silently corrupted.
    const resurrected = findResurrectedIdsByStagingDiff(ctx, queueName);
    if (resurrected.length > 0) {
      throw new JobResurrectionError(queueName, resurrected);
    }

    // Step 3: Find and insert new jobs as stubs.
    // findNewIdsByStagingDiff returns id + state, so we can hand the rows
    // straight to upsertJobStubs without a second round-trip.
    const newStubs = findNewIdsByStagingDiff(ctx, queueName);
    if (newStubs.length > 0) {
      upsertJobStubs(ctx, queueName, newStubs);
    }

    // Step 4: Find and update changed states — but skip jobs polling
    // refreshed after we started, because staging's state for them is stale.
    const changed = findChangedIdsByStagingDiff(ctx, queueName).filter(
      (row) => !wasPolledSince(queueName, row.id, syncStart),
    );
    if (changed.length > 0) {
      upsertJobStubs(ctx, queueName, changed);
    }

    // Step 5: Soft-delete stale jobs — same recently-polled exclusion. A job
    // polling inserted between syncStart and now isn't in staging (we built
    // staging from a Redis snapshot that predated the insert), so the anti-
    // join would misclassify it as stale and stamp it removed.
    const staleIds = findStaleIdsByStagingDiff(ctx, queueName).filter(
      (id) => !wasPolledSince(queueName, id, syncStart),
    );
    // Single `now` for the soft-delete stamp; reused for sync_state below so
    // a row stamped this cycle and `synced_at` line up exactly.
    const now = Date.now();
    const softDeleted = softDeleteJobsByIds(ctx, queueName, staleIds, now);

    // Step 6: Update sync state
    upsertSyncState(ctx, queueName, {
      jobCount: total,
      syncedAt: now,
    });

    return {
      inserted: newStubs.length,
      stateUpdated: changed.length,
      softDeleted,
      total,
    };
  } catch (error) {
    // Resurrections are an invariant violation, not an operational sync
    // failure. Let fullSync aggregate them into FullSyncInvariantError so
    // callers see one accurate log line, not a misleading "sync failed".
    if (error instanceof JobResurrectionError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`SQLite sync failed for queue "${queueName}":`, error);
    return {
      inserted: 0,
      stateUpdated: 0,
      softDeleted: 0,
      total: 0,
      error: message,
    };
  } finally {
    // Skip dropSyncStaging if the connection was swapped — the old connection
    // is closed (DROP would throw), and the new connection's TEMP staging
    // never existed.
    if (ctx.db === syncDb) {
      try {
        dropSyncStaging(ctx);
      } catch (cleanupError) {
        console.error(`Failed to drop sync_staging for queue "${queueName}":`, cleanupError);
      }
    }
    releaseSyncLock();
  }
}

export interface FullSyncResult {
  queues: number;
  totalInserted: number;
  totalSoftDeleted: number;
  totalCompacted: number;
  /** Per-queue failures. Empty array means every queue succeeded. */
  errors: Array<{ queue: string; error: string }>;
}

/**
 * Full sync: discover all queues and sync each one sequentially.
 *
 * Sequential because they share the same staging table. Each queue
 * creates/drops the staging table in its own syncQueue() call.
 *
 * Operational per-queue failures are collected into `errors` rather than
 * aborting the whole sync. A non-empty `errors` array with `queues > 0` means
 * partial success; `queues: 0` with `errors: [{queue: "", ...}]` means
 * discovery itself failed.
 *
 * Invariant violations from `syncQueue` (for example, a soft-deleted job ID
 * reappearing in Redis) are accumulated while the remaining queues continue
 * to sync. Once every queue has been processed, `fullSync` rejects with all
 * invariant failures so callers can report them loudly without starving
 * unrelated queues. Compaction is skipped in that case — deleting an expired
 * resurrected row would erase the evidence the next sync needs to detect the
 * same Redis ID coming back as a brand-new job.
 *
 * @throws FullSyncInvariantError after all queues finish (before compaction)
 * if any queue hit an invariant violation.
 */
export async function fullSync(ctx: Context): Promise<FullSyncResult> {
  let queues: string[];
  try {
    queues = await discoverQueueNames(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("SQLite full sync: queue discovery failed:", error);
    return {
      queues: 0,
      totalInserted: 0,
      totalSoftDeleted: 0,
      totalCompacted: 0,
      errors: [{ queue: "", error: message }],
    };
  }

  let totalInserted = 0;
  let totalSoftDeleted = 0;
  const errors: Array<{ queue: string; error: string }> = [];
  const invariantErrors: Array<{ queue: string; error: string }> = [];

  for (const q of queues) {
    // Sequential by design: queues share the single sync_staging TEMP table
    // on the shared SQLite connection. Parallelizing would corrupt the diff.
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await syncQueue(ctx, q);
      if (result.error) {
        errors.push({ queue: q, error: result.error });
      } else {
        totalInserted += result.inserted;
        totalSoftDeleted += result.softDeleted;
      }
    } catch (error) {
      if (!(error instanceof JobResurrectionError)) {
        throw error;
      }
      invariantErrors.push({ queue: q, error: error.message });
    }
  }

  if (invariantErrors.length > 0) {
    throw new FullSyncInvariantError(invariantErrors);
  }

  // One global compaction pass after every queue has reconciled. Hoisted out
  // of syncQueue because compactRemovedJobs scans `jobs` globally — running
  // it per-queue would re-scan the same rows N times per cycle for no gain.
  // Only compact after invariant checks pass: deleting an expired resurrected
  // row would erase evidence and let the same Redis ID insert as brand-new on
  // the next sync.
  const totalCompacted = compactRemovedJobs(ctx, Date.now(), ctx.config.retentionMs);

  return {
    queues: queues.length,
    totalInserted,
    totalSoftDeleted,
    totalCompacted,
    errors,
  };
}
