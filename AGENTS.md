# AGENTS.md - bullmq-dash

Reference for AI coding agents and developers working on this codebase.

## Project Overview

Terminal UI dashboard for monitoring BullMQ queues. Built with Bun, TypeScript, and @opentui/core.

**Runtime:** Bun >= 1.0.0 (Node.js not supported - ESM import attributes)

## Commands

```bash
# Development
bun run dev              # Run dev mode: bun src/index.ts

# Build
bun run build            # Production build: tsup

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

# Headless / AI agent mode (subcommands output JSON to stdout)
bullmq-dash queues list --redis-host localhost
bullmq-dash jobs list email --redis-host localhost
bullmq-dash jobs get email 42 --redis-host localhost

# Interactive TUI mode (requires --tui flag)
bullmq-dash --tui --redis-host localhost
```

## Web Dashboard Mode

```bash
# Start web dashboard
bullmq-dash --web --redis-host localhost --web-port 8080
# Open http://localhost:8080 in your browser
```

### Web Mode Features
- Global metrics dashboard with queue cards
- Job search via SQLite sidecar index (sub-5ms at 5M rows)
- Sortable columns (ID, name, state, timestamp)
- State filter (All, Active, Waiting, Completed, Failed, Delayed)
- Paginated job list
- Job detail view with collapsible JSON
- Scheduler list and detail

### Web Mode CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--web` | boolean | false | Start web dashboard server |
| `--web-port` | number | 8080 | Port for the web server |

**No test framework configured.** If adding tests, use Bun's built-in test runner.

## Non-Interactive / Headless Mode (AI Agent Usage)

Use subcommands to get machine-readable JSON output without launching the TUI:

```bash
# Queues overview - all queue stats
bullmq-dash queues list --redis-host localhost --redis-port 6379

# List jobs in a queue (all statuses, up to 1000)
bullmq-dash jobs list email --redis-host localhost

# List jobs filtered by state
bullmq-dash jobs list email --redis-host localhost --job-state failed

# Get a single job's full detail
bullmq-dash jobs get email 123 --redis-host localhost

# List schedulers in a queue
bullmq-dash schedulers list email --redis-host localhost

# Get a single scheduler's detail (includes next job + recent history)
bullmq-dash schedulers get email my-cron --redis-host localhost

# Limit results (default: 1000)
bullmq-dash jobs list email --redis-host localhost --page-size 50
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

| Flag                  | Type    | Applies to                     | Description                                                     |
| --------------------- | ------- | ------------------------------ | --------------------------------------------------------------- |
| `--job-state <state>` | string  | `jobs list`                    | Filter jobs: `wait`, `active`, `completed`, `failed`, `delayed` |
| `--page-size <n>`     | number  | `jobs list`, `schedulers list` | Max results to return (default: 1000, must be >= 1)             |
| `--human-friendly`    | boolean | all subcommands                | Human-readable table output (default: JSON)                     |

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

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| `0`  | Success                                           |
| `1`  | Runtime error (unhandled exception)               |
| `2`  | Configuration error (bad/missing CLI flags) or no command given |
| `3`  | Redis connection error                            |

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
bullmq-dash queues list --redis-host localhost | jq '.queues[] | select(.counts.failed > 0)'

# Get total waiting jobs across all queues
bullmq-dash queues list --redis-host localhost | jq '[.queues[].counts.wait] | add'

# Check if a specific queue exists and get its stats
bullmq-dash queues list --redis-host localhost | jq '.queues[] | select(.name == "email")'

# Get all failed jobs in a queue with their IDs
bullmq-dash jobs list email --redis-host localhost --job-state failed | jq '.jobs[] | {id, name, timestamp}'

# Get the stacktrace of a specific failed job
bullmq-dash jobs get email 42 --redis-host localhost | jq '.job.stacktrace'

# List all cron schedulers and their next run times
bullmq-dash schedulers list email --redis-host localhost | jq '.schedulers[] | {key, pattern, next}'
```

## Project Structure

```
src/
├── index.ts          # Entry point - minimal bootstrap
├── app.ts            # Main App class with lifecycle
├── config.ts         # Zod-validated config from CLI args
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
import { z } from "zod";
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
- Use `z.infer<typeof schema>` for Zod-derived types
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

2. **Zod validation with safeParse:**

```typescript
const result = configSchema.safeParse(raw);
if (!result.success) {
  console.error("Configuration error:", result.error.flatten());
  process.exit(1);
}
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
| `ioredis`       | Redis client          |
| `zod`           | Schema validation     |
| `tsup`          | Build tool            |
