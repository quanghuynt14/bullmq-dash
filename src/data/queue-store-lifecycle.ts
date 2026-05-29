import type { Context } from "../context.js";
import { expireStaleRecords } from "./queue-store.js";

const CLEANUP_INTERVAL_MS = 60_000;

export function runQueueStoreCleanupIfDue(ctx: Context, now: number = Date.now()): void {
  const lastCleanupAt = ctx.queueStore.lastCleanupAt;
  if (lastCleanupAt !== null && now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  ctx.queueStore.lastCleanupAt = now;

  try {
    expireStaleRecords(ctx, { now });
  } catch (error) {
    console.warn(
      "Failed to expire stale queue-store records:",
      error instanceof Error ? error.message : error,
    );
  }
}
