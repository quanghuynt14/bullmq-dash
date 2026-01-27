# bullmq-dash

Dashboard for monitoring [BullMQ](https://bullmq.io/) queues.

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
# Interactive setup (prompts for Redis connection)
bullmq-dash

# Connect with CLI options
bullmq-dash --redis-host localhost --redis-port 6379

# Or use environment variables
export REDIS_HOST=localhost
export REDIS_PORT=6379
bullmq-dash
```

### CLI Options

```
bullmq-dash [options]

Options:
  --redis-host <host>      Redis host (default: localhost)
  --redis-port <port>      Redis port (default: 6379)
  --redis-password <pass>  Redis password
  --redis-db <db>          Redis database number (default: 0)
  --poll-interval <ms>     Polling interval in milliseconds (default: 3000)
  --queues <names>         Comma-separated queue names to monitor
  -v, --version            Show version
  -h, --help               Show help
```

### Examples

```bash
# Interactive setup
bullmq-dash

# Connect to remote Redis
bullmq-dash --redis-host 192.168.1.100 --redis-port 6380

# Connect with password
bullmq-dash --redis-host redis.example.com --redis-password secret

# Monitor specific queues only
bullmq-dash --queues email,notifications,payments

# Custom polling interval (5 seconds)
bullmq-dash --poll-interval 5000
```

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

### Environment Variables

Create a `.env` file or set environment variables:

```env
# Redis connection
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password    # Optional
REDIS_DB=0                      # Optional, default: 0

# Polling interval in milliseconds
POLL_INTERVAL=3000              # Optional, default: 3000

# Filter specific queues (comma-separated)
QUEUE_NAMES=queue1,queue2       # Optional, monitors all queues if not set
```

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
