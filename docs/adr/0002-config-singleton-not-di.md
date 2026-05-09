# Process state is threaded as a `Context` bundle, not a singleton

## Context

Every data and UI module in bullmq-dash currently calls `getConfig()` from `src/config.ts` to read connection details, prefix, poll interval, and queue filter. Other process-scoped handles follow the same pattern: `getRedisClient()`, `getSqliteDb()`, the queue cache in `src/data/queues.ts`. Each is wired once at startup (`index.ts:77` for TUI, `json-reporter.ts:337` for headless) and reachable everywhere via a free function.

This shape works for a one-shot CLI, but three forces argue against it:

1. **Tests** mutate a global between cases (`setConfig()` in `beforeEach`), preventing parallel test runs and creating cross-test interference.
2. **A future programmatic API** — exposing bullmq-dash as a library someone can import — is foreclosed by the singleton; it can only run one config per process.
3. **The hidden dependency** — `getQueue(name)` doesn't declare in its signature that it depends on config; a reader has to read the implementation to discover the global it reaches for.

## Decision

Replace the family of `get*()` singletons with a single `Context` object built at startup and threaded as the first argument to data, store, and UI functions.

```ts
type Context = {
  config: Config;
  redis: Redis;             // ioredis client for discovery + raw ops
  db: Database;             // bun:sqlite handle
  queueCache: Map<string, Queue>;
};

function createContext(config: Config): Context { ... }
```

Public function shape becomes `recordObservedJobs(ctx, queue, jobs)`, `listJobs(ctx, queue, filter)`, `reconcileFromRedis(ctx, queue)`, `getQueue(ctx, name)`, etc. — one extra arg, type-visible dependencies.

## Considered alternatives

- **Singleton (status quo)** — rejected for the three reasons in the Context section.
- **Thread `Config` only, leave Redis/SQLite/queue-cache as singletons** — rejected because each non-Config handle would need its own DI step later, churning every signature multiple times. The Context bundle absorbs the next four cross-cutting handles for the same one-arg cost.
- **Class-based (`new BullmqDash(config).start()`)** — rejected because the existing codebase is functional with free-function modules, and the conversion cost is much higher than threading a ctx arg. Functional + ctx achieves the same DI properties without a paradigm shift.

## Consequences

- **Migration scope is large.** Every data module, the queue-data store, polling, the JSON reporter, and most of `app.ts` change signatures. Tests rebuild around per-test `createContext()`.
- **`getConfig()` / `setConfig()` are deleted**, not deprecated. (Aligns with the project's standing preference for clean cuts over coexistence shims.)
- **`createContext()` becomes a public entry point.** A future programmatic API exposes it alongside the data-store functions.
- **Multi-context-per-process is now possible** (e.g. monitoring two Redis instances side-by-side) but not yet implemented; Context is still constructed once at the top of `main()`.
- **The queue-data store deep module from ADR-0001 grows naturally**: its interface becomes `(ctx, …)` everywhere, with `ctx.db` and `ctx.config` available internally.
