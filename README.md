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

- [Bun](https://bun.sh/) >= 1.0.0
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
bullmq-dash --tui --redis-url redis://localhost:6379
```

### CLI Options

```
bullmq-dash [options]

Options:
  --profile <name>         Use a named profile from the config file
  --config <path>          Path to config file
                           (default: ~/.config/bullmq-dash/config.json)
  --redis-url <url>        Full connection URL: redis://[user:pass@]host[:port][/db]
                           (rediss:// for TLS)
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
bullmq-dash --tui --redis-url redis://localhost:6379
bullmq-dash --tui --redis-url redis://user:pass@redis.example.com:6379/0

# Use TLS (rediss://) and percent-encode special chars in passwords
bullmq-dash --tui --redis-url rediss://default:p%40ss@redis.upstash.io:6379

# Connect via a named profile from the config file
bullmq-dash --tui --profile prod

# Monitor specific queues only
bullmq-dash --tui --redis-url redis://localhost --queues email,notifications,payments

# Custom polling interval (5 seconds)
bullmq-dash --tui --redis-url redis://localhost --poll-interval 5000
```

## Connection Profiles

Save Redis connections as named profiles so you don't have to remember (or paste)
hosts and ports every time. Drop a JSON file at `~/.config/bullmq-dash/config.json`
and reference it with `--profile`:

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

Each profile carries a single `redis.url`. The `${VAR}` form interpolates an environment variable as the **whole value** (partial substitution is intentionally not supported), which pairs nicely with managed providers (Upstash, Heroku Redis, Render, Railway, Fly) that hand you a single `REDIS_URL` env var. For inline auth, percent-encode any special characters in the password.

```bash
# Connect using the default profile (defaultProfile field above)
bullmq-dash --tui

# Pick a specific profile
bullmq-dash --tui --profile prod
bullmq-dash queues list --profile prod

# A direct --redis-url overrides whatever the profile would have selected
bullmq-dash queues list --profile prod --redis-url redis://localhost:6380
```

**Resolution order** (highest precedence first):

1. `--redis-url <url>`
2. `redis.url` from `--profile <name>` or the file's `defaultProfile`
3. Otherwise: the interactive prompt (TUI mode) or `CONFIG_ERROR` (subcommands / `--web`)

**File location** — the first match wins:

1. `--config <path>`
2. `$BULLMQ_DASH_CONFIG`
3. `$XDG_CONFIG_HOME/bullmq-dash/config.json`
4. `~/.config/bullmq-dash/config.json`

**Secrets via environment variables.** Any string value of the exact form
`${VAR_NAME}` is substituted from the environment at load time. If the variable
is unset, the command fails fast with `CONFIG_ERROR` rather than connecting
without auth — keep passwords out of the file itself.

## Browser Terminal Mode

`bullmq-dash` includes a built-in web terminal mode powered by a Fastify + PTY bridge.

```bash
bullmq-dash --web --redis-url redis://localhost:6379
```

Then open:

```text
http://127.0.0.1:3001
```

Optional web server flags:

- `--web-host <host>` (default: `127.0.0.1`)
- `--web-port <port>` (default: `3001`)

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
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **TUI Framework**: [@opentui/core](https://github.com/pinkpixel-co/opentui)
- **Queue Library**: [BullMQ](https://bullmq.io/)
- **Redis Client**: [ioredis](https://github.com/redis/ioredis)
- **Config Validation**: [Zod](https://zod.dev/)
- **Build Tool**: Bun bundler

## Color Theme

`bullmq-dash` uses the [Catppuccin Mocha](https://catppuccin.com/) color palette for a modern, easy-on-the-eyes aesthetic:

## Related Projects

- [BullMQ](https://bullmq.io/) - Premium Message Queue for Node.js
- [Bull Board](https://github.com/felixmosh/bull-board) - Web-based dashboard for BullMQ

## License

MIT
