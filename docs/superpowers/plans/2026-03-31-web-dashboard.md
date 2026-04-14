# `bullmq-dash --web` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--web` flag to bullmq-dash that starts an embedded Bun HTTP server serving a Svelte web dashboard, with a SQLite sidecar for sub-5ms search/sort across millions of BullMQ jobs.

**Architecture:** Single Bun process with three layers: (1) HTTP server handles API routes and serves static files, (2) SQLite sidecar provides indexed search/sort on job metadata synced from Redis, (3) existing data layer handles Redis/BullMQ operations. Frontend is a SvelteKit SPA built to static files.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, SvelteKit + adapter-static, Tailwind CSS v4, Vite

**Spec:** `docs/superpowers/specs/2026-03-31-web-dashboard-design.md`

---

## File Structure

### New files to create:

| File | Responsibility |
|------|---------------|
| `src/web/server.ts` | Bun HTTP server: static file serving + API router |
| `src/web/routes.ts` | API route handler definitions |
| `src/web/sqlite.ts` | SQLite sidecar: schema, queries, sync from Redis |
| `web/package.json` | SvelteKit frontend dependencies |
| `web/svelte.config.js` | SvelteKit config (adapter-static) |
| `web/vite.config.ts` | Vite config with Tailwind CSS v4 |
| `web/src/app.html` | SvelteKit HTML shell |
| `web/src/app.css` | Global styles (Catppuccin Mocha theme) |
| `web/src/lib/api.ts` | Frontend API client |
| `web/src/lib/types.ts` | Shared TypeScript types |
| `web/src/routes/+page.svelte` | Dashboard page |
| `web/src/routes/+layout.svelte` | App layout |
| `web/src/routes/queues/[name]/+page.svelte` | Queue detail + job list |
| `web/src/routes/queues/[name]/jobs/[id]/+page.svelte` | Job detail |
| `web/src/routes/queues/[name]/schedulers/+page.svelte` | Scheduler list |
| `web/src/lib/components/*.svelte` | UI components |

### Files to modify:

| File | Change |
|------|--------|
| `src/config.ts` | Add `--web` and `--web-port` flags |
| `src/index.ts` | Add `--web` mode routing |
| `src/polling.ts` | Add SQLite sync during poll cycles |
| `build.ts` | Add SvelteKit build step + copy web output |
| `package.json` | Add `build:web`, `dev:web` scripts |
| `AGENTS.md` | Document `--web` mode |

---

## Tasks

### Task 1: CLI Integration — `--web` and `--web-port` flags
### Task 2: SQLite Sidecar — schema, queries, sync
### Task 3: HTTP Server + API Routes
### Task 4: SvelteKit Frontend Setup
### Task 5: Shared Frontend Types and API Client
### Task 6: Dashboard Page
### Task 7: Queue Detail Page with Search/Sort/Filter/Pagination
### Task 8: Job Detail Page
### Task 9: Scheduler Pages
### Task 10: Build Integration
### Task 11: Polling Integration — sync SQLite during existing poll cycles
### Task 12: Update AGENTS.md with `--web` documentation
