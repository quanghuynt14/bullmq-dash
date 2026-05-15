# AGENTS.md - bullmq-dash

Reference for AI coding agents and developers working on this codebase.

## Project Overview

Terminal UI dashboard for monitoring BullMQ queues. Built with Bun, TypeScript, and @opentui/core.

**Runtime:** Bun >= 1.3.0 (Node.js not supported - ESM import attributes)

## Commands

```bash
# Development
bun run dev              # Run dev mode: bun src/index.ts

# Build
bun run build            # Production build: bun build.ts

# Type checking
bun run typecheck        # tsc --noEmit

# Linting
bun run lint             # Run oxlint
bun run lint:fix         # Run oxlint with auto-fix

# Formatting
bun run format           # Format with oxfmt
bun run format:check     # Check formatting

# Run production
bun run start            # bun dist/index.js

# Security release / Socket gates
bun run security:verify-package      # Verify source/entrypoint import and npm tarball policy
bun run security:verify-source-control # Verify .env/.envrc/.npmrc are ignored and not tracked
bun run security:verify-lockfile     # Verify Bun lockfile and frozen CI installs
bun run security:verify-workflows    # Verify pinned actions, Socket CLI, and publish workflow policy
bun run security:score               # Gate the published package.json version against the accepted-alert set
bun run security:audit-0.2.7         # Audit the original immutable Socket target (historical)
bun run security:release             # All of the above in publish order

# Headless / AI agent mode (subcommands output JSON to stdout)
bullmq-dash queues list --redis-url redis://localhost
bullmq-dash jobs list email --redis-url redis://localhost
bullmq-dash jobs get email 42 --redis-url redis://localhost

# Interactive TUI mode (requires --tui flag)
bullmq-dash --tui --redis-url redis://localhost
```

**Tests:** Uses Bun's built-in test runner (`bun test`).

**Socket package score:** `socket package score npm bullmq-dash@<version>
--markdown` scores the package already published to npm, not the local
worktree. The CLI can exit `0` while reporting alert rows; use
`bun run security:score` after publishing to gate the version against the
accepted-alert allowlist (`scripts/socket-score.ts:ACCEPTED_ALERT_TYPES`).

## Non-Interactive / Headless Mode (AI Agent Usage)

Use subcommands to get machine-readable JSON output without launching the TUI:

```bash
# Queues overview - all queue stats
bullmq-dash queues list --redis-url redis://localhost:6379

# List jobs in a queue (all statuses, up to 1000)
bullmq-dash jobs list email --redis-url redis://localhost

# List jobs filtered by state
bullmq-dash jobs list email --redis-url redis://localhost --job-state failed

# Get a single job's full detail
bullmq-dash jobs get email 123 --redis-url redis://localhost

# List schedulers in a queue
bullmq-dash schedulers list email --redis-url redis://localhost

# Get a single scheduler's detail (includes next job + recent history)
bullmq-dash schedulers get email my-cron --redis-url redis://localhost

# Delete a queue (destructive - with --dry-run preview)
bullmq-dash queues delete email --redis-url redis://localhost --dry-run

# Delete a queue (destructive - skip confirmation)
bullmq-dash queues delete email --redis-url redis://localhost --yes

# Limit results (default: 1000)
bullmq-dash jobs list email --redis-url redis://localhost --page-size 50
```

### Commands

| Command                                 | Description                       |
| --------------------------------------- | --------------------------------- |
| `queues list`                           | List all queues with job counts   |
| `jobs list <queue>`                     | List jobs in a queue              |
| `jobs get <queue> <job-id>`             | Get full detail for a single job  |
| `schedulers list <queue>`               | List schedulers in a queue        |
| `schedulers get <queue> <scheduler-id>` | Get detail for a single scheduler |

### Command Options

| Flag                  | Type    | Applies to                     | Description                                                                                                                                                                                                                                   |
| --------------------- | ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--job-state <state>` | string  | `jobs list`                    | Filter jobs: `wait`, `active`, `completed`, `failed`, `delayed`                                                                                                                                                                               |
| `--page-size <n>`     | number  | `jobs list`, `schedulers list` | Max results to return (default: 1000, must be >= 1)                                                                                                                                                                                           |
| `--human-friendly`    | boolean | all subcommands                | Human-readable table output (default: JSON)                                                                                                                                                                                                   |
| `--profile <name>`    | string  | all commands                   | Use a named profile from the config file                                                                                                                                                                                                      |
| `--config <path>`     | string  | all commands                   | Path to config file (default: `~/.config/bullmq-dash/config.json`)                                                                                                                                                                            |
| `--redis-url <url>`   | string  | all commands                   | Full Redis URL (`redis://host[:port][/db]`, or `rediss://` for TLS). The single way to specify a Redis connection — discrete `--redis-host` / `--redis-port` / `--redis-password` / `--redis-db` flags were removed in the URL-only redesign. |

### Connection Profiles

Saved Redis connections live in a JSON config file (default
`~/.config/bullmq-dash/config.json`, or override via `--config <path>` /
`$BULLMQ_DASH_CONFIG`). Resolution: CLI flag > profile > error.

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": { "redis": { "url": "redis://localhost:6379" } },
    "prod": {
      "redis": { "url": "${REDIS_PROD_URL}" },
      "queues": ["payments", "notifications"]
    },
    "upstash": { "redis": { "url": "${REDIS_URL}" } }
  }
}
```

Each profile carries a single `redis.url`; the schema is strict so unknown
fields (e.g. legacy `host`/`port`) are rejected as `CONFIG_ERROR`. Strings of
the form `${VAR_NAME}` interpolate an environment variable as the **whole
value** (partial substitution is intentionally not supported). Unset
references are a hard `CONFIG_ERROR` (exit 2) — secrets never silently
resolve to empty.

### Progressive Help

Every level supports `--help` so agents can discover commands incrementally:

```bash
bullmq-dash --help                    # Global overview: all commands
bullmq-dash jobs --help               # Resource-level: available actions for jobs
bullmq-dash jobs list --help          # Action-level: flags, options, and examples
```

### Output Schemas

**Queues overview** (`queues list`):

```typescript
interface QueuesOverview {
  timestamp: string; // ISO 8601
  queues: Array<{
    name: string;
    counts: {
      wait: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      schedulers: number;
    };
    isPaused: boolean;
    total: number;
  }>;
  metrics: {
    queueCount: number;
    jobCounts: {
      wait: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      total: number;
    };
  };
}
```

**Jobs list** (`jobs list <queue> [--job-state <s>]`):

```typescript
interface JobsList {
  timestamp: string;
  queue: string;
  jobState: string; // "all" or the specific job state
  jobs: Array<{
    id: string;
    name: string;
    state: string;
    timestamp: number;
  }>;
  total: number;
}
```

**Job detail** (`jobs get <queue> <job-id>`):

```typescript
interface JobDetailOutput {
  timestamp: string;
  queue: string;
  job: {
    id: string;
    name: string;
    state: string;
    timestamp: number;
    data: unknown;
    opts: unknown;
    attemptsMade: number;
    failedReason?: string;
    stacktrace?: string[];
    returnvalue?: unknown;
    processedOn?: number;
    finishedOn?: number;
    progress?: number | object;
    repeatJobKey?: string;
    delay?: number;
  };
}
```

**Schedulers list** (`schedulers list <queue>`):

```typescript
interface SchedulersList {
  timestamp: string;
  queue: string;
  schedulers: Array<{
    key: string;
    name: string;
    pattern?: string;
    every?: number;
    next?: number;
    iterationCount?: number;
    tz?: string;
  }>;
  total: number;
}
```

**Scheduler detail** (`schedulers get <queue> <scheduler-id>`):

```typescript
interface SchedulerDetailOutput {
  timestamp: string;
  queue: string;
  scheduler: {
    key: string;
    name: string;
    pattern?: string;
    every?: number;
    next?: number;
    iterationCount?: number;
    tz?: string;
    id?: string | null;
    limit?: number;
    startDate?: number;
    endDate?: number;
    template?: { data?: unknown; opts?: unknown };
    nextJob?: {
      id: string;
      state: string;
      timestamp: number;
      delay?: number;
      data: unknown;
      opts: unknown;
    };
    recentJobs?: Array<{
      id: string;
      state: string;
      timestamp: number;
      processedOn?: number;
      finishedOn?: number;
      failedReason?: string;
    }>;
  };
}
```

### Exit Codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | Success                                                         |
| `1`  | Runtime error (unhandled exception)                             |
| `2`  | Configuration error (bad/missing CLI flags) or no command given |
| `3`  | Redis connection error                                          |

### Idempotency

All current subcommands (`queues list`, `jobs list`, `jobs get`, `schedulers list`, `schedulers get`) are **read-only** and **idempotent**. They perform no writes to Redis and can be called any number of times without side effects. Agents should rely on this guarantee.

Agents can safely:

- Poll the same command repeatedly for monitoring
- Retry on transient failures without risk of duplicate actions
- Run multiple commands in parallel against the same queues

When destructive subcommands are added (e.g., `jobs delete`, `jobs retry`):

- They **MUST** support `--dry-run` to preview the effect without executing it.
- They **MUST** support `--yes` / `--force` to skip interactive confirmation (agents cannot answer prompts).
- They **MUST** be idempotent — retrying the same command with the same arguments must produce the same result and not cause unintended duplicate side effects.

### Structured Error Output (stderr)

All errors are written to `stderr` as JSON:

```json
{
  "error": "Redis connection failed",
  "code": "REDIS_ERROR",
  "details": "connect ECONNREFUSED 127.0.0.1:6379"
}
```

Error codes: `CONFIG_ERROR`, `REDIS_ERROR`, `RUNTIME_ERROR`

### Common Agent Tasks

```bash
# Check if any queue has failed jobs
bullmq-dash queues list --redis-url redis://localhost | jq '.queues[] | select(.counts.failed > 0)'

# Get total waiting jobs across all queues
bullmq-dash queues list --redis-url redis://localhost | jq '[.queues[].counts.wait] | add'

# Check if a specific queue exists and get its stats
bullmq-dash queues list --redis-url redis://localhost | jq '.queues[] | select(.name == "email")'

# Get all failed jobs in a queue with their IDs
bullmq-dash jobs list email --redis-url redis://localhost --job-state failed | jq '.jobs[] | {id, name, timestamp}'

# Get the stacktrace of a specific failed job
bullmq-dash jobs get email 42 --redis-url redis://localhost | jq '.job.stacktrace'

# List all cron schedulers and their next run times
bullmq-dash schedulers list email --redis-url redis://localhost | jq '.schedulers[] | {key, pattern, next}'
```

## Project Structure

```
src/
├── index.ts          # Entry point - minimal bootstrap
├── app.ts            # Main App class with lifecycle
├── config.ts         # CLI args, command parsing, and manual config validation
├── errors.ts         # Structured JSON error output to stderr
├── formatters.ts     # Human-friendly table/text formatters
├── json-reporter.ts  # Headless subcommand data fetching + output
├── state.ts          # Singleton state manager
├── polling.ts        # Polling manager singleton
├── data/             # Data layer
│   ├── redis.ts      # Redis connection
│   ├── queues.ts     # Queue operations
│   ├── jobs.ts       # Job operations
│   ├── schedulers.ts # Scheduler operations
│   └── metrics.ts    # Global metrics
└── ui/               # UI components (@opentui/core)
    ├── layout.ts
    ├── queue-list.ts
    ├── job-list.ts
    ├── job-detail.ts
    └── ...
```

## Code Style

### Imports

1. **ESM with .js extension for local imports** (required):

```typescript
import { App } from "./app.js";
import { getConfig } from "../config.js";
import type { QueueStats } from "../data/queues.js";
```

2. **No extension for package imports:**

```typescript
import { Queue } from "bullmq";
import { RedisConnection } from "bullmq";
```

3. **Use `type` keyword for type-only imports:**

```typescript
import type { CliRenderer, BoxRenderable } from "@opentui/core";
```

4. **Combined value + type imports:**

```typescript
import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
```

### Naming Conventions

| Element          | Convention            | Example                                  |
| ---------------- | --------------------- | ---------------------------------------- |
| Files            | kebab-case            | `queue-list.ts`, `job-detail.ts`         |
| Functions        | camelCase             | `getConfig()`, `discoverQueueNames()`    |
| Variables        | camelCase             | `redisClient`, `queueNamesCache`         |
| Constants        | UPPER_SNAKE_CASE      | `PAGE_SIZE`, `SCAN_COUNT`                |
| Types/Interfaces | PascalCase            | `Config`, `AppState`, `QueueStats`       |
| Classes          | PascalCase            | `App`, `StateManager`                    |
| UI element types | PascalCase + Elements | `QueueListElements`, `JobDetailElements` |

### TypeScript

- **Strict mode enabled** - no implicit any, strict null checks
- **Target:** ES2023
- **Module:** ESNext with bundler resolution
- Keep runtime config/profile validation explicit and dependency-free
- Prefer union types over enums: `type FocusedPane = 'queues' | 'jobs'`
- Use nullish coalescing: `queues[index] ?? null`

### Error Handling

1. **Top-level try-catch with instanceof check:**

```typescript
try {
  await app.start();
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
}
```

2. **Config validation with structured errors:**

```typescript
const result = validateConfig(raw);
if (result.success) {
  return result.data;
}

writeError({
  error: "Configuration error",
  code: "CONFIG_ERROR",
  details: result.errors.join("; "),
});
process.exit(1);
```

3. **Empty catch for non-critical UI operations:**

```typescript
try {
  return JSON.stringify(data, null, 2);
} catch {
  return String(data);
}
```

### UI Component Pattern

Each UI module in `src/ui/` follows this pattern:

```typescript
// 1. Define elements interface
export interface XxxElements {
  container: BoxRenderable;
  title: TextRenderable;
  // ...
}

// 2. Factory function - creates elements
export function createXxx(renderer: CliRenderer, parent: BoxRenderable): XxxElements {
  const container = new BoxRenderable(renderer, {
    /* ... */
  });
  parent.add(container);
  // ...
  return { container, title /* ... */ };
}

// 3. Update function - handles state changes
export function updateXxx(elements: XxxElements /* state params */): void {
  // Update element properties based on state
}

// 4. Optional show/hide for modals
export function showXxx(elements: XxxElements): void {
  /* ... */
}
export function hideXxx(elements: XxxElements): void {
  /* ... */
}
```

### Singleton Pattern

Used for global state and managers:

```typescript
class StateManager {
  private state: AppState;
  // ...
}
export const stateManager = new StateManager();
```

Or lazy initialization:

```typescript
let configInstance: Config | null = null;
export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
```

### Async Patterns

- Use `async/await` consistently (not raw Promises)
- Use `Promise.all()` for parallel operations:

```typescript
const [counts, isPaused] = await Promise.all([queue.getJobCounts(), queue.isPaused()]);
```

### Color Theme

Uses Catppuccin Mocha palette. Key colors:

- `#1e1e2e` - base background
- `#cdd6f4` - text
- `#a6e3a1` - green (active/success)
- `#f9e2af` - yellow (waiting)
- `#89b4fa` - blue (completed)
- `#f38ba8` - red (failed)

## Dependencies

| Package         | Purpose               |
| --------------- | --------------------- |
| `@opentui/core` | Terminal UI framework |
| `bullmq`        | Queue library         |
| Bun bundler     | Build tool            |

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Agent skills

### Backlog

GitHub Issues at `quanghuynt14/bullmq-dash` via the `gh` CLI. See `docs/agents/backlog.md`.

### Triage labels

Canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
