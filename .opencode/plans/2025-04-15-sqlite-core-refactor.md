# SQLite Core Refactor — Implementation Plan

**Date:** 2025-04-15
**Status:** In Progress
**Goal:** Move SQLite sync from web-only feature to core infrastructure used by both TUI and headless CLI.

## Context

The web frontend has been removed. `src/web/sqlite.ts` remains as the sole survivor and needs to move into `src/data/` alongside the other data modules. Additionally, the sync orchestration (`syncQueue`, `fullSync`) should be extracted into a separate `src/data/sync.ts` module, and several P0 bugs need fixing (stale jobs never cleaned, `data_preview` always null in full sync).

## Tasks

### Task 1: Move `src/web/sqlite.ts` → `src/data/sqlite.ts`

**Goal:** Relocate the pure DB layer into the data directory.

**Steps:**
1. Copy `src/web/sqlite.ts` to `src/data/sqlite.ts`
2. Remove `syncQueue()` and `fullSync()` from the new file (they move to `sync.ts` in Task 2)
3. Import path stays `"../config.js"` (correct relative path from `src/data/`)
4. Update `tests/sqlite.test.ts`: change import from `"../src/web/sqlite.js"` → `"../src/data/sqlite.js"`
5. Remove `web: false, webPort: 8080` from `setConfig()` calls in tests (these fields no longer exist)
6. Delete `src/web/` directory entirely
7. Run tests to verify

**Files changed:**
- `src/data/sqlite.ts` (new — moved from `src/web/sqlite.ts`)
- `tests/sqlite.test.ts` (import path update, config cleanup)
- `src/web/` (deleted)

### Task 2: Create `src/data/sync.ts`

**Goal:** Extract sync orchestration into its own module. Fix P0 bug: `deleteStaleJobs()` is never called.

**Steps:**
1. Create `src/data/sync.ts` with:
   - `syncQueue(queueName)` — fetches all jobs from Redis, upserts into SQLite, **then calls `deleteStaleJobs()`** with the fetched IDs
   - `fullSync()` — discovers all queues and runs `syncQueue()` for each
2. Fix the `data_preview` issue: when calling `upsertJobs`, pass the actual data from Redis jobs (not `undefined`)
3. Import from `./jobs.js` (getAllJobs), `./queues.js` (discoverQueueNames), `./sqlite.js` (upsertJobs, deleteStaleJobs)

**Files changed:**
- `src/data/sync.ts` (new)

### Task 3: Add FTS5 Full-Text Search

**Goal:** Replace `LIKE '%term%'` O(n) scans with FTS5 sub-ms search.

**Steps:**
1. Add FTS5 virtual table creation to the SCHEMA in `src/data/sqlite.ts`
2. Add triggers to keep FTS5 in sync with the `jobs` table (INSERT, UPDATE, DELETE)
3. Update `queryJobs()`: when `search` is provided, JOIN with `jobs_fts` using `MATCH` instead of `LIKE`
4. Add a `rebuildFtsIndex()` function for manual reindex
5. Add FTS5 tests to `tests/sqlite.test.ts`

**Files changed:**
- `src/data/sqlite.ts` (FTS5 schema, triggers, updated queryJobs, rebuildFtsIndex)
- `tests/sqlite.test.ts` (FTS5 tests)

### Task 4: Integrate SQLite into TUI Polling

**Goal:** TUI automatically syncs to SQLite on every poll + runs background fullSync.

**Steps:**
1. In `src/polling.ts`: import `upsertJobs` from `./data/sqlite.js`, upsert after fetching jobs
2. In `src/app.ts`: init SQLite on startup, run fullSync on 60s interval, close on cleanup

**Files changed:**
- `src/polling.ts` (SQLite upsert after job fetch)
- `src/app.ts` (SQLite lifecycle management)

### Task 5: Integrate SQLite into Headless CLI

**Goal:** Headless subcommands also populate SQLite as a side effect.

**Steps:**
1. In `src/json-reporter.ts`: init SQLite after Redis connects, upsert in fetchJobsList, close on cleanup

**Files changed:**
- `src/json-reporter.ts` (SQLite init, upsert, cleanup)

### Task 6: Final Verification

**Checklist:**
- [ ] No references to `src/web/` anywhere in the codebase
- [ ] All 108+ tests pass
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun run build` succeeds
- [ ] No `web` or `webPort` references in config

## Architecture After Refactor

```
src/data/
├── redis.ts        # Redis connection
├── queues.ts       # Queue discovery + stats
├── jobs.ts         # Job CRUD (Redis)
├── schedulers.ts   # Scheduler operations (Redis)
├── metrics.ts      # Global metrics
├── sqlite.ts       # SQLite DB layer (schema, queries, upsert)
└── sync.ts         # Sync orchestration (syncQueue, fullSync)
```

Both TUI (`app.ts` + `polling.ts`) and headless CLI (`json-reporter.ts`) init SQLite on startup and close on exit. TUI additionally runs `fullSync()` in background every 60s.
