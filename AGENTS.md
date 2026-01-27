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
```

**No test framework configured.** If adding tests, use Bun's built-in test runner.

## Project Structure

```
src/
├── index.ts          # Entry point - minimal bootstrap
├── app.ts            # Main App class with lifecycle
├── config.ts         # Zod-validated config from env
├── state.ts          # Singleton state manager
├── polling.ts        # Polling manager singleton
├── data/             # Data layer
│   ├── redis.ts      # Redis connection
│   ├── queues.ts     # Queue operations
│   ├── jobs.ts       # Job operations
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
| `dotenv`        | Environment variables |
| `tsup`          | Build tool            |

## Environment Variables

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=        # optional
REDIS_DB=0             # optional
POLL_INTERVAL=3000     # ms
QUEUE_NAMES=q1,q2      # optional, comma-separated
```
