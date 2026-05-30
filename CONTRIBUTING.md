# Contributing

Thanks for helping improve bullmq-dash. This project is a Bun-first TypeScript
terminal UI for operating BullMQ queues.

## Setup

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Use Bun >= 1.3.0. Node.js is not a supported runtime because the source uses
ESM import attributes.

## Development Workflow

1. Open or pick an issue before larger changes.
2. Keep changes scoped to one behavior or maintenance task.
3. Add or update tests for CLI behavior, data-layer logic, and regression fixes.
4. Run the relevant checks before opening a PR:

```bash
bun run typecheck
bun run lint
bun test
```

For release or package-policy changes, also run:

```bash
bun run security:release
```

## CLI And Redis Safety

Headless commands should keep JSON on stdout and structured JSON errors on
stderr. Read-only commands must stay idempotent. Destructive commands must have
`--dry-run` and a non-interactive confirmation escape hatch such as `--yes`.

## Design

Read `DESIGN.md` before visual or TUI changes. The product direction is
terminal-native, data-dense, and minimal: let the queue data carry the UI.

## Pull Requests

Include:

- What changed.
- How you verified it.
- Any Redis/BullMQ setup needed to reproduce behavior.
- Screenshots or terminal output for UI changes when useful.
