# bullmq-dash

Terminal and browser dashboard for [BullMQ](https://bullmq.io/)

<img width="1491" height="854" alt="SCR-20260127-gsqa" src="https://github.com/user-attachments/assets/739d7729-b6cd-4933-a9e8-96e8cf84d33a" />

## Features

- **Real-time monitoring** - Watch queues and jobs update live with configurable polling
- **Web dashboard** - Rank queues by task size or failures, inspect failed jobs, and retry one job or a failed batch from a local browser UI
- **Queue overview** - View all BullMQ queues with job counts, failure counts, and task-size sorting
- **Job inspection** - Browse jobs by status, view details, data, and error stacktraces
- **Failed-job recovery** - Find failed jobs quickly and retry one job by ID or a filtered batch
- **Scheduler monitoring** - View Job Schedulers (repeatable jobs) with patterns, iterations, and job history
- **Job management** - Delete jobs from the TUI and retry failed jobs from headless mode
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

# Browser dashboard
bullmq-dash --web --redis-url <redis-url>
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
  --web                    Launch local browser dashboard
  --web-host <host>        Bind host for --web (default: 127.0.0.1)
  --web-port <port>        Bind port for --web (default: 3000)
  --web-read-only          Disable live retry actions in the browser/API
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

# Launch the local web UI
bullmq-dash --web --redis-url <local-redis-url>
bullmq-dash --web --redis-url <remote-redis-url> --web-port 4173

# Use TLS
bullmq-dash --tui --redis-url <tls-redis-url>
bullmq-dash --web --redis-url <tls-redis-url>

# Connect via a named profile from the config file
bullmq-dash --tui --profile prod
bullmq-dash --web --profile prod

# Monitor specific queues only
bullmq-dash --tui --redis-url <redis-url> --queues email,notifications,payments

# Custom polling interval (5 seconds)
bullmq-dash --tui --redis-url <redis-url> --poll-interval 5000
bullmq-dash --web --redis-url <redis-url> --poll-interval 5000
```

### Web Dashboard

`--web` starts a local Bun HTTP server and serves a data-dense dashboard at
`http://127.0.0.1:3000` by default.

```bash
bullmq-dash --web --redis-url <redis-url>
bullmq-dash --web --redis-url <redis-url> --web-host 0.0.0.0 --web-port 4173
bullmq-dash --web --redis-url <redis-url> --web-read-only
```

Web mode has no built-in authentication. Keep the default loopback bind for
local use; bind `0.0.0.0` only on trusted networks or behind an authenticated
proxy/tunnel.

The first screen is the operational workspace: ranked queues on the left,
filtered jobs in the center, and job detail on the right. Queue/job search,
page-size controls, failed-job stacktrace display, and an attention strip keep
large installations scannable. Queue ranking defaults to task size and can
switch to failed, waiting, active, completed, delayed, or name. Retry actions are
guarded server-side: dry-runs are safe previews, live batch retry uses an
in-browser confirmation, all live retry API calls require an explicit JSON
confirmation, and `--web-read-only` blocks live retry requests while keeping
dry-run previews available.

### Headless Queue Operations

Headless commands print JSON by default, so they are safe to pipe through `jq`
or run from automation.

```bash
# Rank queues by task size, largest first
bullmq-dash queues list --redis-url <redis-url> --sort-by task-size

# Rank queues by failed jobs
bullmq-dash queues list --redis-url <redis-url> --sort-by failed

# Find failed jobs in a queue
bullmq-dash jobs failed email --redis-url <redis-url>

# Preview retrying one failed job, then run it
bullmq-dash jobs retry email --redis-url <redis-url> --job-id 42 --dry-run
bullmq-dash jobs retry email --redis-url <redis-url> --job-id 42 --yes

# Preview a filtered batch retry
bullmq-dash jobs retry email --redis-url <redis-url> --job-state failed --since 1h --dry-run
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
      "queues": ["payments", "notifications"],
      "cacheTtlMs": 86400000
    },
    "upstash": { "redis": { "url": "${REDIS_URL}" } }
  }
}
```

Each profile carries a single `redis.url`. `cacheTtlMs` controls the SQLite observation-cache TTL and defaults to 24 hours. The `${VAR}` form interpolates an environment variable as the **whole value** (partial substitution is intentionally not supported), which pairs nicely with managed providers (Upstash, Heroku Redis, Render, Railway, Fly) that hand you a single `REDIS_URL` env var. Prefer environment-backed profile values for authenticated Redis URLs.

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
| `s`            | Cycle queue sorting |
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

# Optional manual Socket score for an already-published version
bun run security:score

# Verify forbidden local-only files are ignored and not tracked
bun run security:verify-source-control

# Verify Bun package manager pinning, bun.lock tracking, and frozen installs
bun run security:verify-lockfile

# Verify CI/publish workflows pin actions and lock down releases
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
`dist/index.js`, rejects literal credentialed `redis://` URL examples in
packed text — i.e. `redis://`-prefixed authority forms that embed a
`username:password` pair before the host (a focused doc-leakage guard, not a
general secret scanner; base64 / env-var-interpolated / split-string forms
are out of scope by design and belong to repo-level tools like git-secrets
or gitleaks), enforces packed-tarball size and entry-count limits, and
verifies the stripped publish manifest. Note: `ioredis` remains a transitive
dependency through `bullmq`; the policy blocks _direct_ imports only.

`bun run security:score` is an optional manual audit for a version that already
exists on npm. It compares the Socket alert set against the accepted-alert
allowlist, but it is intentionally not part of the publish workflow because
Socket scoring can lag or fail after npm accepts the immutable package version.

`bun run security:verify-workflows` rejects mutable GitHub Action refs,
`pull_request_target` triggers, and direct `${{ github.event.* }}` interpolation
in workflow commands. It also verifies CI and publish workflows run the
source-control, lockfile, workflow, and package policy verifiers, CI uses
read-only permissions, and the npm publish workflow rejects publish secrets,
is release-only, runs the source-control, lockfile, workflow, and package
verifiers before publishing, uses least privilege, keeps npm lifecycle scripts
enabled, and publishes with provenance.

`bun run security:verify-source-control` rejects tracked `.env` / `.envrc` /
`.npmrc` files, build output, publish manifest backups, and generated package
archives, and verifies that the ignore policy covers those local-only files.

`bun run security:verify-lockfile` rejects missing or untracked `bun.lock`,
competing package manager lockfiles, a mismatched `packageManager` pin, and CI
or publish workflows that install dependencies without `--frozen-lockfile`.

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
