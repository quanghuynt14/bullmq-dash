# SQLite is cache-primary; soft-delete with retention window

## Context

bullmq-dash maintains a SQLite cache of every observed BullMQ job. Three downstream features depend on it: full-text search across many jobs, fast paginated browsing, and a historical view of jobs past Redis retention. The original sync logic deleted any job from SQLite that was no longer in Redis, which silently broke the historical-view requirement.

## Decision

1. **Reads are cache-primary.** All read paths (TUI list/detail, headless `jobs list`/`jobs get`, future search/history views) query SQLite. Redis is reached only by writers — foreground polling, the headless one-shot writer, and background reconciliation.
2. **Removal is a soft-delete.** When reconciliation finds a job present in SQLite but absent from Redis, it sets `removed_at = now` instead of deleting the row. A separate compaction pass removes rows where `removed_at < now − retention_window` (configurable; default to be set at implementation time).
3. **BullMQ job IDs are treated as monotonic.** A job ID that has been soft-deleted reappearing in Redis is treated as an error (logged loudly, then skipped) rather than silently undeleting. If the assumption is wrong, we want to find out fast.

## Considered alternatives

- **Mirror Redis (the original behavior)** — rejected because it's incompatible with the historical-view feature.
- **Preserve forever (true archive)** — rejected because storage growth is unbounded and would force an independent compaction policy anyway; soft-delete with a window subsumes this.
- **Live-when-connected, cache-when-disconnected (two read paths picked at runtime)** — rejected because callers would need to handle two consistency contracts; cache-primary unifies them.

## Consequences

- Reconciliation no longer deletes rows; the deletion path becomes compaction, scheduled separately.
- The `jobs` table needs a `removed_at INTEGER NULL` column with an index supporting "current only" filters.
- Read APIs need a view selector (`live | history | all`) so callers can opt into the historical tail.
- Storage growth is bounded by the retention window, but disk usage will rise with high-throughput queues; users may need to tune the window or move the SQLite path off `/tmp`.
