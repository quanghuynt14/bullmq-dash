# bullmq-dash

Terminal UI dashboard for [BullMQ](https://bullmq.io/)

<img width="1491" height="854" alt="SCR-20260127-gsqa" src="https://github.com/user-attachments/assets/739d7729-b6cd-4933-a9e8-96e8cf84d33a" />

## Features

- **Real-time monitoring** - Watch queues and jobs update live with configurable polling
- **Queue overview** - View all BullMQ queues with job counts and status
- **Job inspection** - Browse jobs by status, view details, data, and error stacktraces
- **Scheduler monitoring** - View Job Schedulers (repeatable jobs) with patterns, iterations, and job history
- **Job management** - Add, cancel, delete, and retry jobs directly from the dashboard
- **Global metrics** - Track enqueue/dequeue rates across all queues

## Requirements

- [Bun](https://bun.sh/) >= 1.3.0
- Redis server with BullMQ queues

## Installation

```bash
# Install globally via npm
npm install -g bullmq-dash

# Or use bunx/npx to run directly
bunx bullmq-dash
npx bullmq-dash
```

## Usage

### Quick Start

```bash
# Interactive setup (prompts for a Redis URL)
bullmq-dash --tui

# Connect with a URL
bullmq-dash --tui --redis-url <redis-url>
```

### CLI Options

```
bullmq-dash [options]

Options:
  --profile <name>         Use a named profile from the config file
  --config <path>          Path to config file
                           (default: ~/.config/bullmq-dash/config.json)
  --redis-url <url>        Full Redis connection URL
                           (TLS URLs are supported)
  --poll-interval <ms>     Polling interval in milliseconds (default: 3000)
  --queues <names>         Comma-separated queue names to monitor
  -v, --version            Show version
  -h, --help               Show help
```

Connections are always specified as a single Redis URL — the discrete
`--redis-host` / `--redis-port` / `--redis-password` / `--redis-db` flags
were retired so there is one obvious way to point bullmq-dash at a server.

### Examples

```bash
# Interactive setup (prompts for a URL)
bullmq-dash --tui

# Connect via a URL
bullmq-dash --tui --redis-url <local-redis-url>
bullmq-dash --tui --redis-url <remote-redis-url>

# Use TLS
bullmq-dash --tui --redis-url <tls-redis-url>

# Connect via a named profile from the config file
bullmq-dash --tui --profile prod

# Monitor specific queues only
bullmq-dash --tui --redis-url <redis-url> --queues email,notifications,payments

# Custom polling interval (5 seconds)
bullmq-dash --tui --redis-url <redis-url> --poll-interval 5000
```

## Connection Profiles

Save Redis connections as named profiles so you don't have to remember (or paste)
hosts and ports every time. Drop a JSON file at `~/.config/bullmq-dash/config.json`
and reference it with `--profile`:

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": { "redis": { "url": "<local-redis-url>" } },
    "prod": {
      "redis": { "url": "${REDIS_PROD_URL}" },
      "queues": ["payments", "notifications"]
    },
    "upstash": { "redis": { "url": "${REDIS_URL}" } }
  }
}
```

Each profile carries a single `redis.url`. The `${VAR}` form interpolates an environment variable as the **whole value** (partial substitution is intentionally not supported), which pairs nicely with managed providers (Upstash, Heroku Redis, Render, Railway, Fly) that hand you a single `REDIS_URL` env var. Prefer environment-backed profile values for authenticated Redis URLs.

```bash
# Connect using the default profile (defaultProfile field above)
bullmq-dash --tui

# Pick a specific profile
bullmq-dash --tui --profile prod
bullmq-dash queues list --profile prod

# A direct --redis-url overrides whatever the profile would have selected
bullmq-dash queues list --profile prod --redis-url <redis-url>
```

**Resolution order** (highest precedence first):

1. `--redis-url <url>`
2. `redis.url` from `--profile <name>` or the file's `defaultProfile`
3. Otherwise: the interactive prompt (TUI mode) or `CONFIG_ERROR` (subcommands)

**File location** — the first match wins:

1. `--config <path>`
2. `$BULLMQ_DASH_CONFIG`
3. `$XDG_CONFIG_HOME/bullmq-dash/config.json`
4. `~/.config/bullmq-dash/config.json`

**Secrets via environment variables.** Any string value of the exact form
`${VAR_NAME}` is substituted from the environment at load time. If the variable
is unset, the command fails fast with `CONFIG_ERROR` rather than connecting
without auth — keep passwords out of the file itself.

## Keyboard Shortcuts

### Navigation

| Key       | Action                              |
| --------- | ----------------------------------- |
| `j` / `↓` | Move down                           |
| `k` / `↑` | Move up                             |
| `Tab`     | Switch between queues and jobs pane |
| `←` / `→` | Previous/next page (in job list)    |

### Actions

| Key            | Action              |
| -------------- | ------------------- |
| `Enter`        | View job details    |
| `d`            | Delete selected job |
| `r`            | Refresh data        |
| `q` / `Ctrl+C` | Quit                |

### Job Status Filter

| Key | Status       |
| --- | ------------ |
| `1` | Latest (all) |
| `2` | Waiting      |
| `3` | Active       |
| `4` | Completed    |
| `5` | Failed       |
| `6` | Delayed      |
| `7` | Scheduled    |

### Scheduler View (Key `7`)

When viewing scheduled jobs, the job list shows all Job Schedulers (repeatable jobs):

| Key     | Action                                    |
| ------- | ----------------------------------------- |
| `Enter` | View scheduler details                    |
| `j`     | Jump to next delayed job (in detail view) |

The scheduler detail modal shows:

- **Basic info**: Key, name, pattern/interval, timezone
- **Statistics**: Iterations count, limits, created/next/end dates
- **Job template**: Default job data and options
- **Next delayed job**: Preview of the next job to be executed
- **Recent history**: Last 10 completed/failed jobs from this scheduler

### Metrics Bar

| Metric | Description                    |
| ------ | ------------------------------ |
| QUEUES | Total number of queues         |
| WAIT   | Jobs waiting to be processed   |
| ACTIVE | Jobs currently being processed |
| DONE   | Completed jobs                 |
| FAIL   | Failed jobs                    |
| DELAY  | Delayed jobs                   |
| ENQ    | Jobs enqueued per minute       |
| DEQ    | Jobs dequeued per minute       |

## Development

### Scripts

```bash
# Run in development mode
bun run dev

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Build for production
bun run build

# Run production build
bun run start

# Audit the immutable 0.2.7 Socket target (historical evidence)
bun run security:audit-0.2.7

# Score the configured package version after it is published
bun run security:score

# Verify forbidden local-only files are ignored and not tracked
bun run security:verify-source-control

# Verify Bun package manager pinning, bun.lock tracking, and frozen installs
bun run security:verify-lockfile

# Verify CI/publish workflows pin actions, lock down releases, and score after publish
bun run security:verify-workflows

# Verify source import policy, npm tarball contents, and stripped publish manifest
bun run security:verify-package

# Run release security checks in order
bun run security:release
```

`bun run security:audit-0.2.7` audits the originally published security target
(`bullmq-dash@0.2.7`). Because npm versions are immutable, this is historical
evidence only — it reports the alerts on that artifact but cannot fix them.

`bun run security:verify-package` packs the release tarball end-to-end. It
checks the source manifest, rejects direct source or packed-entrypoint imports
of `ioredis` or `zod`, rejects dynamic-code or shell primitives in source or
`dist/index.js`, rejects credentialed Redis URL examples in packed text,
enforces packed-tarball size and entry-count limits, and verifies the stripped
publish manifest.

`bun run security:score` runs the Socket package score against the version in
`package.json` (must already be published to npm). It compares the alert set
against an accepted-alert allowlist that includes the capabilities a Redis
monitoring tool legitimately needs (`networkAccess`, `urlStrings`,
`filesystemAccess`, `envVars`), Socket's transient `recentlyPublished` window,
and the transitive alert types present in the `bullmq` and `@opentui/core`
graphs. The gate exits nonzero only when an alert type appears outside that set,
which surfaces real regressions from dependency updates without paging on every
publish.

`bun run security:verify-workflows` rejects mutable GitHub Action refs,
`pull_request_target` triggers, and direct `${{ github.event.* }}` interpolation
in workflow commands. It also verifies CI and publish workflows run the
source-control, lockfile, workflow, and package policy verifiers, CI uses
read-only permissions, and the npm publish workflow scopes secrets to approved
step env entries, is release-only, runs the source-control, lockfile, workflow,
and package verifiers before publishing, uses least privilege, keeps npm
lifecycle scripts enabled, publishes with provenance, installs the Socket CLI by
the configured exact version `1.1.94`, and runs the post-publish Socket score
gate.

`bun run security:verify-source-control` rejects tracked `.env` / `.envrc` /
`.npmrc` files, build output, publish manifest backups, and generated package
archives, and verifies that the ignore policy covers those local-only files.

`bun run security:verify-lockfile` rejects missing or untracked `bun.lock`,
competing package manager lockfiles, a mismatched `packageManager` pin, and CI
or publish workflows that install dependencies without `--frozen-lockfile`.

`bun run security:score` reads the package name and version from `package.json`.
Socket package scores are registry lookups, so the exact version must already be
published before this command can score it. The command checks npm registry
existence first, then exits nonzero if the version is unpublished or if Socket
reports any package or transitive alerts for that version. If Socket reports
`recentlyPublished`, the command still fails and tells you to rerun the gate
after Socket's new-publish window clears. See
[`docs/security-release.md`](docs/security-release.md) for the release checklist
and why already-published versions cannot be changed by local fixes. See
[`docs/adr/0003-socket-clean-release-boundary.md`](docs/adr/0003-socket-clean-release-boundary.md)
for why the current Redis dashboard architecture must remain blocked until a
same-package rewrite, package split, or accepted Socket policy proves
`bullmq-dash@0.3.0` clean.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **TUI Framework**: [@opentui/core](https://github.com/pinkpixel-co/opentui)
- **Queue Library**: [BullMQ](https://bullmq.io/)
- **Build Tool**: Bun bundler

## Color Theme

`bullmq-dash` uses the [Catppuccin Mocha](https://catppuccin.com/) color palette for a modern, easy-on-the-eyes aesthetic:

## Related Projects

- [BullMQ](https://bullmq.io/) - Premium Message Queue for Node.js
- [Bull Board](https://github.com/felixmosh/bull-board) - Web-based dashboard for BullMQ

## License

MIT
