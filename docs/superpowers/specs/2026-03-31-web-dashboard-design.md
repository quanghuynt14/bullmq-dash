# Design: `bullmq-dash --web` — Web Dashboard with SQLite Sidecar

**Date:** 2026-03-31
**Status:** Approved

## Problem

bullmq-dash is a terminal-only dashboard. For 5M+ jobs, existing web solutions (bull-board, bullmq-ui, Upqueue.io) all fail at search/sort because they rely on Redis sorted sets with offset-based pagination — no secondary indexing exists in any BullMQ web tool.

## Solution

Add a `--web` flag that starts an embedded Bun HTTP server serving a Svelte web dashboard, backed by a SQLite sidecar index for sub-5ms search/sort across millions of jobs.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deployment | Embedded single process | Matches Mongoku pattern; `bullmq-dash --web` and done |
| Search engine | SQLite sidecar (bun:sqlite) | No Redis module dependency; sub-5ms queries at 5M rows |
| Searchable fields | ID, name, state, timestamp | Covers 90% of use cases; ~1GB for 5M rows |
| Frontend | Svelte + SvelteKit + adapter-static | Lighter than React, smaller bundles, fast runtime |
| Auth | None | Developer tool; users can add reverse proxy auth |
| API | Bun HTTP server with JSON endpoints | Direct access to existing data layer, no network overhead |

## Architecture

```
User runs: bullmq-dash --web --redis-host localhost --web-port 8080

┌─────────────────────────────────────────────┐
│              Bun Process                    │
│                                             │
│  ┌──────────────┐    ┌──────────────────┐   │
│  │  HTTP Server │    │  SQLite Sidecar  │   │
│  │  (Bun.serve) │    │  (bun:sqlite)    │   │
│  │  Port 8080   │    │  bullmq-dash.db  │   │
│  └──────┬───────┘    └────────┬─────────┘   │
│         │                     │              │
│  ┌──────┴─────────────────────┴──────────┐   │
│  │         Data Layer (existing)         │   │
│  │  src/data/redis.ts, queues.ts, etc.   │   │
│  └──────────────────┬────────────────────┘   │
│                     │                        │
│  ┌──────────────────┴────────────────────┐   │
│  │     Static Files (Svelte build)       │   │
│  │     dist/web/                         │   │
│  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
                     │
                     ▼
              ┌──────────┐
              │  Redis   │
              └──────────┘
```

- `--tui` mode unchanged (terminal UI)
- Subcommand mode unchanged (headless JSON output)
- `--web` and `--tui` are mutually exclusive

## SQLite Schema

```sql
CREATE TABLE jobs (
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data_preview TEXT,
  PRIMARY KEY (queue, id)
);

CREATE INDEX idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX idx_jobs_name ON jobs(name);
CREATE INDEX idx_jobs_timestamp ON jobs(timestamp);
CREATE INDEX idx_jobs_search ON jobs(queue, name, state, timestamp);
```

- ~200 bytes/row × 5M rows ≈ 1GB on disk
- `idx_jobs_search` covers the common query: search by name within queue, filter by state, sort by timestamp
- Query: `SELECT * FROM jobs WHERE queue='email' AND name LIKE '%send%' ORDER BY timestamp DESC LIMIT 25` — sub-5ms

## API Endpoints

| Method | Path | Source | Description |
|--------|------|--------|-------------|
| `GET` | `/api/queues` | Redis | All queue stats |
| `GET` | `/api/queues/:name/jobs` | SQLite | Paginated jobs with search/sort |
| `GET` | `/api/queues/:name/jobs/:id` | Redis | Single job detail |
| `GET` | `/api/queues/:name/schedulers` | Redis | Paginated schedulers |
| `GET` | `/api/queues/:name/schedulers/:key` | Redis | Scheduler detail |
| `GET` | `/api/metrics` | Redis | Global metrics |

**Query params for `/api/queues/:name/jobs`:**
- `?q=searchterm` — text search on job name (SQLite LIKE)
- `?state=failed` — filter by state
- `?sort=timestamp` — sort column
- `?order=desc` — sort direction
- `?page=1&pageSize=25` — pagination

**Split logic:**
- Search/filter/sort/pagination → SQLite
- Job detail, schedulers, metrics → Redis (live data, small result set)

## Sync Strategy

SQLite syncs via the existing polling mechanism:

1. **Initial sync** — One-time full sync on first start. Batched inserts of 1000 rows. Takes ~2-5 min for 5M jobs. UI shows "Indexing..." progress.
2. **Incremental sync** — On each poll cycle (3s), upsert the currently-visible queue's jobs into SQLite.
3. **Full background sync** — Every 60s, sync all queues.
4. **Cleanup** — Delete jobs from SQLite that no longer exist in Redis (completed/failed TTL).
5. **Fallback** — If SQLite not yet synced, API falls back to direct Redis queries.

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard: global metrics, queue list cards with live counts |
| `/queues/[name]` | Queue detail: search bar, state filter tabs, sortable columns, pagination |
| `/queues/[name]/jobs/[id]` | Job detail: full info, data, stacktrace, return value |
| `/queues/[name]/schedulers` | Scheduler list and detail |

**Key UI features:**
- Search bar (debounced, hits SQLite via API)
- State filter tabs (All, Active, Waiting, Completed, Failed, Delayed)
- Sortable table columns (ID, Name, State, Timestamp)
- Pagination (page controls + page size selector)
- Auto-refresh (polls `/api/queues` every 3s for live metrics)

**Tech:** SvelteKit + adapter-static, Tailwind CSS v4, TypeScript, Vite

## CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--web` | boolean | false | Start web dashboard server |
| `--web-port` | number | 8080 | Port for the web server |

## Project Structure Changes

```
src/
├── web/
│   ├── server.ts        # Bun HTTP server (route handler)
│   ├── routes.ts        # API route definitions
│   └── sqlite.ts        # SQLite sidecar (schema, queries, sync)
└── ...existing files...

web/                      # SvelteKit project (separate from src/)
├── src/
│   ├── routes/
│   │   ├── +page.svelte          # Dashboard
│   │   └── queues/[name]/
│   │       ├── +page.svelte      # Queue detail + job list
│   │       ├── jobs/[id]/
│   │       │   └── +page.svelte  # Job detail
│   │       └── schedulers/
│   │           └── +page.svelte  # Schedulers
│   └── lib/
│       ├── api.ts                # API client
│       └── components/           # UI components
├── svelte.config.js
├── vite.config.ts
└── package.json
```

## Performance Comparison vs Existing Solutions

| Operation | bull-board (Redis) | This design (SQLite) |
|-----------|-------------------|---------------------|
| Search "email" in 5M jobs | Not supported | <5ms |
| Page to job #4,999,975 | ~30s (large ZRANGE offset) | <1ms (LIMIT/OFFSET with index) |
| Sort by job name | Not possible | <10ms (ORDER BY with index) |
| Filter by state + search | Not supported | <5ms (composite index) |

## Scope Boundaries

**In scope for v1:**
- Embedded HTTP server with `--web` flag
- SQLite sidecar with basic search/sort
- Dashboard, queue detail, job detail pages
- Auto-sync with Redis

**Out of scope for v1:**
- Authentication
- WebSocket real-time push (use polling)
- Bulk operations (retry all, delete all)
- Job data field indexing
- Multi-Redis support
