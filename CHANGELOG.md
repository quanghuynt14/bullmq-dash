# Changelog

All notable changes to bullmq-dash are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`bullmq-dash@0.3.0` ships through a hardened publish surface.** `prepack` rewrites the manifest to strip dev dependencies, source-only scripts, package manager metadata, and graph-rewrite fields, keeping only the `dist`-only file allowlist. `bun run security:verify-package` runs that pack end-to-end and rejects unexpected runtime dependencies, direct runtime source or packed-entrypoint imports of `ioredis` or `zod`, dynamic-code or shell primitives in source or `dist/index.js`, credentialed Redis URL examples in packed text, oversized tarballs, and bundled dependencies. `prepublishOnly` runs the source-control, lockfile, workflow, and package verifiers before manual publishes.
- **Direct `ioredis` and `zod` dependencies removed.** `src/data/redis.ts` now uses BullMQ's `RedisConnection` (ioredis remains a transitive dep through bullmq). `src/config.ts` and `src/profiles.ts` use a hand-rolled validator. The published runtime deps shrink from four (`@opentui/core`, `bullmq`, `ioredis`, `zod`) to two (`@opentui/core`, `bullmq`).
- **Socket score gate added.** `bun run security:score` scores the published package via the pinned Socket CLI (`@socketsecurity/cli@1.1.94`) and compares the result against an accepted-alert allowlist that includes capabilities inherent to a Redis monitoring tool (`networkAccess`, `urlStrings`, `filesystemAccess`, `envVars`), Socket's transient `recentlyPublished` window, and the transitive alert types present in the `bullmq` and `@opentui/core` graphs. The gate exits nonzero only when Socket reports an alert type outside that set, which surfaces real regressions from dependency updates without paging on every publish.
- **CI supply chain hardened.** GitHub Actions in CI and publish workflows are pinned by commit SHA, Dependabot tracks the `github-actions` ecosystem, and `bun run security:verify-workflows` rejects mutable action refs, `pull_request_target`, direct `${{ github.event.* }}` command interpolation, missing source-control/lockfile/workflow/package verifier steps, disabled npm lifecycle scripts, Socket CLI version drift from `1.1.94`, and publish workflows that omit post-publish Socket scoring.
- **Source-control local-only guard.** `bun run security:verify-source-control` verifies `dist/`, `.env`, `.envrc`, `.npmrc`, `.package.json.prepack-backup`, and generated `*.tgz` package archives are ignored and not tracked.
- **Published package provenance.** `package.json` declares `publishConfig.provenance: true`, so `npm publish` records the build's GitHub Actions origin in the package manifest.
- **Immutable target audit recorded.** `bun run security:audit-0.2.7` audits the immutable published `bullmq-dash@0.2.7` artifact and reports its Socket alerts, registry metadata, deprecation status, and direct dependencies. It is historical evidence — `0.2.7` cannot be modified once published.

### Removed (BREAKING)

- **`--web` browser terminal mode.** Removed `bullmq-dash --web`, `--web-host`, and `--web-port`, along with the Fastify + PTY + xterm.js bridge that ran the TUI inside a browser tab. The web mode duplicated TUI behavior over a WebSocket-piped child process and pulled in `fastify` / `@fastify/websocket` for a single endpoint. Use `--tui` directly (locally or over SSH) for the interactive dashboard, or the JSON subcommands for headless integrations. Internal: `src/web-server.ts` and `formatRedisUrl` (only consumed by the web-server child-process bootstrap) were deleted.

### Changed (BREAKING)

- **Redis connections are URL-only.** `--redis-host` / `--redis-port` / `--redis-password` / `--redis-db` were removed; the single supported form is `--redis-url redis://[user:pass@]host[:port][/db]` (or `rediss://` for TLS). The profile schema dropped its discrete `host`/`port`/`password`/`db`/`username`/`tls` fields too — only `redis.url` is accepted, and unknown fields fail strict-schema validation as `CONFIG_ERROR` (exit 2). The interactive prompt now asks for a single URL with a re-prompt loop on bad input, instead of three sequential host/port/password questions. Internally the URL is parsed once into the discrete shape BullMQ's Redis connection layer consumes, so there's no behavior change at the connection layer — only at the user-facing surface. Migration: if you had a profile with `{ "redis": { "host": "...", "port": 6379, "password": "..." } }`, replace it with `{ "redis": { "url": "redis://:password@host:6379" } }` (percent-encode special chars in the password). Scripts using `--redis-host localhost --redis-port 6380` should switch to `--redis-url redis://localhost:6380`.

### Added

- **Redis connection URLs.** New `--redis-url <url>` flag and matching `redis.url` profile field accept the full `redis://[user:pass@]host[:port][/db]` shape (and `rediss://` for TLS). Pairs naturally with managed providers that hand you a single `REDIS_URL` env var: `"redis": { "url": "${REDIS_URL}" }`. URL-encoded passwords are decoded automatically. Internal `username` (Redis 6 ACL) and `tls` fields flow through to BullMQ's Redis connection layer.
- **Connection profiles + config file.** Save named Redis connections to `~/.config/bullmq-dash/config.json` (or `--config <path>` / `$BULLMQ_DASH_CONFIG` / `$XDG_CONFIG_HOME/bullmq-dash/config.json`) and pick one with `--profile <name>`. A `defaultProfile` field auto-applies a profile when `--profile` is omitted. Resolution order: CLI flags > profile > built-in defaults. Strings of the form `${VAR_NAME}` are substituted from the environment at load time so passwords stay out of the file; an unset reference is a hard `CONFIG_ERROR` (exit 2). Backward compatible — when no config file is present and no `--profile` / `--config` is given, behavior is unchanged.
- **`jobs retry <queue>` subcommand.** Bulk-retry failed BullMQ jobs from the CLI. `--dry-run` (the hero flag) prints matched count and sample job IDs without touching Redis. Filters: `--job-state failed` (required), `--since 30s|5m|1h|24h|7d` (filter by time-of-failure, falls back to creation timestamp when `finishedOn` is missing), `--name <exact>` (exact job-name match), `--page-size <=10000>` (safety rail). Live retries are best-effort: per-job errors collect into `errors[]` and the loop never stops mid-batch. JSON envelope: `{matched, retried, errors, sampleJobIds, totalFailed, truncated}`.

### Changed

- **Redis connection failure exit code: `3` → `1`** (affects all subcommands: `queues list`, `queues delete`, `jobs list`, `jobs get`, `jobs retry`, `schedulers list`, `schedulers get`). Aligns with the documented exit-code taxonomy (`1` = runtime/fetch error, `3` = `jobs retry` per-job partial failure). Scripts that branched on exit `3` for Redis-down need to switch to `1`.
- **`--page-size` cap** is now enforced at 10000 for `jobs retry` (CONFIG_ERROR / exit 2 above the cap). `jobs list` and `schedulers list` are unaffected.

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
