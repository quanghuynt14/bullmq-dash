# Changelog

All notable changes to bullmq-dash are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-04-26

### Fixed
- **Web terminal keyboard input.** Custom key handler now captures all keydown events and sends escape sequences directly via WebSocket, bypassing xterm's built-in handling that wasn't forwarding keys to the PTY. Added `tabindex="0"` for terminal focus and removed deprecated `allowProposedApi` option.

## [0.2.0] - 2026-04-19

### Added
- **5M-scale incremental sync.** Background sync now scales to queues with millions of jobs without holding them all in memory. Job IDs paginate from Redis in 5000-at-a-time chunks via `queue.getRanges()`, land in a per-connection SQLite TEMP staging table, and diff against the `jobs` table with SQL JOINs. New jobs become stubs (id + state only), changed states get updated in place, stale jobs get deleted. No more "re-fetch everything every 60s" that broke on large queues.
- **Lazy data population.** Background sync only persists cheap fields (id, queue, state). Name, timestamp, and data_preview are filled in when jobs are actually viewed in the TUI or fetched via CLI. A `--job-state`-filtered `jobs:list` now primes the cache for the jobs you just read.
- **`sync_state` metadata table.** Tracks per-queue sync stats (job count, last synced timestamp) for observability. Exposed via `getSyncState()`.
- **Module-level sync lock with stale-lock stealing.** Only one sync runs at a time (staging table is per-connection). If a sync hangs past 10 minutes (e.g., a never-resolving promise), the next call steals the lock with a logged warning rather than refusing every future sync.
- **Polling coexistence.** Background sync no longer overwrites state that the 3s polling loop just refreshed. `markPolledWrites()` tracks recent polling writes; sync skips state overwrites and stale-deletes for any job polled after the sync's snapshot timestamp. Cache consistency is within one polling interval instead of up to one full sync interval.
- **Connection-swap guard.** If `closeSqliteDb()` fires mid-sync (shutdown race), `syncQueue` aborts with a clear error instead of operating on a fresh connection that has no staging table.

### Changed
- **`fullSync` error shape.** Returns `{ queues, totalInserted, totalDeleted, errors: [{queue, error}] }`. Per-queue failures no longer abort the loop; they collect into `errors`. Queue-discovery failure returns one entry with `queue: ""` so callers can distinguish an empty Redis from a broken sync.
- **`JobSummary.data` is now `data?: unknown`.** The Redis fetch path (polling, json-reporter) exposes the payload on the summary so the SQLite upsert can write `data_preview` without bidirectional casts.
- **`upsertJobs` hardened against bad payloads.** `safeDataPreview` catches JSON.stringify failures on BigInt values, circular references, and throwing getters — the offending row gets `data_preview = null` instead of poisoning the whole upsert batch.
- **Stale-row delete split into find + delete.** `findStaleIdsByStagingDiff` returns candidate IDs; `deleteJobsByIds` batches the deletion. This lets sync filter out recently-polled IDs before deleting them.

### Removed
- **`deleteStaleJobs(queue, activeIds[])`.** Replaced by the staging-diff flow. Old brute-force path is gone.

### Infrastructure
- **New test suite.** `src/data/sync.test.ts` covers `syncQueue`, `fullSync`, the sync lock, stale-lock stealing, polling-vs-sync coexistence, and connection-swap abort (12 tests, fully mocked — no Redis needed).
- **Lint clean.** Documented the three intentional `no-await-in-loop` call sites (cursor-based Redis scans, offset pagination, sequential per-queue sync) with inline disables and one-line rationale. Oxlint now reports 0 warnings.
- Test count: 124 → 138 (+14 new). Typecheck clean.
