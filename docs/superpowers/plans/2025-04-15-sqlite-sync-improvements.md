# SQLite Sync Improvements — First-Principles Analysis

> **Research artifact:** Comparative analysis of [steipete/discrawl](https://github.com/steipete/discrawl) vs bullmq-dash Redis-to-SQLite sync architecture. Identifies structural gaps and prioritized improvements.

**Date:** 2025-04-15

---

## The Core Problem (First Principles)

Both projects solve the same fundamental problem: **syncing data from a remote authoritative source into a local SQLite index for fast querying**. The constraints differ — Discord API vs Redis — but the architectural challenges are identical:

1. **How do you know what changed?** (Change detection)
2. **How do you avoid re-fetching everything?** (Incremental sync)
3. **How do you handle interrupted syncs?** (Recovery)
4. **How do you keep the index fresh?** (Staleness management)
5. **How do you make search fast?** (Indexing strategy)
6. **How do you handle concurrent reads/writes?** (Concurrency)

---

## Principle-by-Principle Comparison

### 1. Change Detection

| | Discrawl | bullmq-dash |
|---|---|---|
| **Mechanism** | Cursor-based (`sync_state` table tracks per-channel latest/backfill message IDs) | None — re-fetches all jobs every cycle |
| **Granularity** | Per-channel, per-direction (forward + backfill) | Per-queue, bulk re-fetch |
| **Live events** | Gateway WebSocket captures real-time creates/updates/deletes | No event stream; relies on periodic polling |

**Key insight:** Discrawl treats sync as a **stateful process with cursors**. bullmq-dash treats it as a **stateless re-fetch**. The cursor approach means Discrawl only fetches what's new, while bullmq-dash re-fetches up to 10k jobs per queue every 60 seconds regardless of changes.

### 2. Incremental Sync

| | Discrawl | bullmq-dash |
|---|---|---|
| **Forward sync** | Fetches only messages newer than last cursor | Re-fetches all jobs up to 10k cap |
| **Backfill** | Paginated backward until history complete, marked with flag | No backfill concept |
| **Incomplete detection** | `syncGuildIncompleteBatches` finds and resumes unfinished channels | No tracking of incomplete syncs |

**Key insight:** Discrawl's `sync_state` table with `history_complete` flags is the critical differentiator. It means you can interrupt a sync at any point, restart, and it picks up exactly where it left off. bullmq-dash has no such resilience — an interrupted sync simply means waiting for the next 60-second cycle.

### 3. Recovery & Resilience

| | Discrawl | bullmq-dash |
|---|---|---|
| **Interrupted sync** | Resumes from cursor position | Restarts from scratch |
| **Error handling** | Classifies errors (missing_access, unknown_channel) — skips gracefully | Fire-and-forget `.catch()` on initial sync |
| **Panic recovery** | Go recover() in tail workers | No crash recovery |
| **Timeout per unit** | 5-minute per-channel timeout | No per-queue timeout |

**Key insight:** Discrawl's error classification (`skipSyncError`) is a mature pattern. It distinguishes permanent failures (missing access) from transient ones, avoiding infinite retries on dead channels. bullmq-dash silently swallows errors.

### 4. Staleness Management

| | Discrawl | bullmq-dash |
|---|---|---|
| **Deleted data** | Soft deletes (`deleted_at` column) + append-only `message_events` audit log | `deleteStaleJobs()` defined but **never called** |
| **Stale accumulation** | Gateway delivers delete events in real-time | Dead jobs persist indefinitely in SQLite |
| **Freshness signal** | Cursor positions indicate how up-to-date each channel is | No freshness metadata |

**Key insight:** This is bullmq-dash's biggest architectural gap. Jobs removed from Redis (completed + cleaned up by BullMQ's TTL) will accumulate as ghosts in SQLite. Search results will include jobs that no longer exist. Discrawl handles this via both soft-delete tracking and real-time Gateway delete events.

### 5. Search & Indexing

| | Discrawl | bullmq-dash |
|---|---|---|
| **Strategy** | FTS5 full-text search on content + author + channel name | `LIKE '%term%'` on job name column |
| **Performance** | CTE with 20x candidate oversampling, cap at 5000 | Standard `LIMIT/OFFSET` with `COUNT(*)` |
| **Fallback** | Degrades to LIKE if FTS query syntax fails | No fallback (single strategy) |
| **Additional** | Optional OpenAI embeddings for semantic search | No semantic search |

**Key insight:** `LIKE '%term%'` cannot use B-tree indexes efficiently — it's a full table scan. At 5M rows, this would be seconds, not sub-5ms. FTS5 is the correct tool for this. Discrawl's approach of CTE -> FTS candidates -> join is the textbook pattern.

### 6. Concurrency

| | Discrawl | bullmq-dash |
|---|---|---|
| **Write serialization** | Single writer connection (`MaxOpenConns=1`) | WAL mode + singleton handle, but no explicit write serialization |
| **Parallel sync** | Worker pool sized to GOMAXPROCS (8-32 workers) | `Promise.allSettled` on all queues (unbounded) |
| **Progress tracking** | Mutex-protected progress struct, periodic heartbeat logs | No progress tracking |
| **Batch writes** | Transactional batching per channel | Transactional batching per queue |

**Key insight:** Both use WAL mode and transactional batching correctly. Discrawl is more disciplined about write serialization (single writer) and has bounded parallelism. bullmq-dash could theoretically overwhelm SQLite with unbounded concurrent queue syncs, though WAL handles this acceptably.

---

## Critical Gaps in bullmq-dash

Distilled from first principles, these are the structural weaknesses:

1. **No sync cursors** — Re-fetching everything is wasteful and limits scalability. With cursor-based sync, you'd only fetch jobs newer than the last sync point.

2. **No stale data cleanup** — `deleteStaleJobs()` exists but is never called. Ghost jobs will pollute search results over time.

3. **No FTS5** — `LIKE '%term%'` is O(n). At scale this is a significant performance issue. FTS5 is a near-zero-cost addition for SQLite.

4. **10k job cap** — `getAllJobs(queueName, undefined, 10000)` means queues with >10k jobs have incomplete data. No indication to the user.

5. **No sync state tracking** — No way to know if a sync completed, failed partially, or is in progress. No way to resume.

6. **No data_preview in full sync path** — `syncQueue()` passes `data: undefined`, so `data_preview` is always null from the primary sync pathway.

7. **Fire-and-forget error handling** — Initial sync errors are silently swallowed with `.catch()`.

---

## What bullmq-dash Does Well

- **Redis as source of truth for detail views** — Job detail always hits Redis directly (`src/web/routes.ts:50-60`), using SQLite only as a search index. This is the correct architecture.
- **Redis fallback when SQLite is empty** — Graceful degradation during initial sync (`src/web/routes.ts:20-31`).
- **WAL mode + PRAGMA tuning** — The right choices for a sidecar cache.
- **Composite primary key `(queue, id)`** — Correct data modeling for BullMQ's per-queue ID space.
- **Ephemeral DB in `/tmp/`** — Appropriate for a cache that can be rebuilt. Avoids stale-across-restart issues.

---

## Actionable Improvements (Ranked by Impact)

| Priority | Improvement | Effort | Impact |
|---|---|---|---|
| **P0** | Call `deleteStaleJobs()` during sync cycle | Trivial | Eliminates ghost jobs |
| **P0** | Add FTS5 virtual table for job name + data_preview | Small | Enables sub-ms search at scale |
| **P1** | Add `sync_state` table with per-queue cursors | Medium | Eliminates redundant re-fetching |
| **P1** | Remove 10k cap or make it configurable with pagination | Small | Handles large queues correctly |
| **P1** | Actually populate `data_preview` in full sync | Trivial | Search over job data, not just names |
| **P2** | Add sync progress tracking (started_at, completed_at, job_count) | Small | Observability |
| **P2** | Bound concurrent queue syncs (e.g., pool of 8) | Small | Prevents SQLite write storms |
| **P3** | BullMQ event listener for real-time updates (like Discrawl's Gateway tail) | Medium | Near-real-time freshness |

---

## Reference: Discrawl Architecture Summary

- **Repo:** https://github.com/steipete/discrawl
- **Language:** Go
- **Storage:** SQLite with WAL, FTS5, `synchronous=NORMAL`, `mmap_size=268MB`
- **Key files:** `internal/store/` (schema, upserts, queries), `internal/syncer/` (sync orchestration, tail)
- **Key patterns:** Cursor-based incremental sync, soft deletes, append-only audit log, bounded worker pools, error classification with graceful skip

## Reference: bullmq-dash SQLite Architecture

- **Key files:** `src/web/sqlite.ts` (schema, upsert, query), `src/web/server.ts` (sync scheduling), `src/polling.ts` (incremental piggyback)
- **Schema:** Single `jobs` table with composite PK `(queue, id)`, 3 B-tree indexes
- **Sync:** Full re-fetch every 60s + opportunistic polling piggyback for current queue
