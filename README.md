# BullMQ Dash

A modern terminal UI dashboard for monitoring [BullMQ](https://bullmq.io/) queues in real-time.

![npm version](https://img.shields.io/npm/v/bullmq-dash)
![license](https://img.shields.io/npm/l/bullmq-dash)

## Features

- **Real-time monitoring** - Watch queues and jobs update live with configurable polling
- **Queue overview** - View all BullMQ queues with job counts and status
- **Job inspection** - Browse jobs by status, view details, data, and error stacktraces
- **Scheduler monitoring** - View Job Schedulers (repeatable jobs) with patterns, iterations, and job history
- **Job management** - Delete jobs directly from the TUI
- **Global metrics** - Track enqueue/dequeue rates across all queues
- **Modern UI** - Beautiful Catppuccin Mocha color theme
- **Keyboard-driven** - Full keyboard navigation for efficient workflow

## Requirements

- [Bun](https://bun.sh/) >= 1.0.0 (required - Node.js is not supported due to OpenTUI's ESM import attributes)
- Redis server with BullMQ queues

## Installation

```bash
# Install globally via npm
npm install -g bullmq-dash

# Or use bunx/npx to run directly
bunx bullmq-dash
npx bullmq-dash
```

### From Source

```bash
# Clone the repository
git clone https://github.com/quanghuynt14/bullmq-tui.git
cd bullmq-tui

# Install dependencies
bun install

# Build
bun run build
```

## Usage

### Quick Start

```bash
# If installed globally
bullmq-dash

# Or run from source
bun dist/index.js

# Or use the dev script
bun run dev
```

### Configuration

Create a `.env` file in the project root:

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

## UI Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ BullMQ                                    Connected localhost:6379 │
├─────────────────────────────────────────────────────────────────┤
│ QUEUES:3  WAIT:42  ACTIVE:5  DONE:1.2K  FAIL:3  ENQ:120/m  DEQ:115/m │
├──────────────┬──────────────────────────────────────────────────┤
│ QUEUES       │ JOBS                                             │
│              │ Status: [1:latest]  2:wait  3:active  ...        │
│ > email      │                                                  │
│   payments   │ job-123  send-email     completed  2m ago        │
│   notifications│ job-124  send-email     active     1m ago      │
│              │ job-125  send-email     waiting    30s ago       │
│              │                                                  │
├──────────────┴──────────────────────────────────────────────────┤
│ j/k: navigate | Tab: switch pane | Enter: view | d: delete | q: quit │
└─────────────────────────────────────────────────────────────────┘
```

### Metrics Bar

| Metric | Description                    | Color                |
| ------ | ------------------------------ | -------------------- |
| QUEUES | Total number of queues         | White                |
| WAIT   | Jobs waiting to be processed   | Yellow (red if >100) |
| ACTIVE | Jobs currently being processed | Green                |
| DONE   | Completed jobs                 | Blue                 |
| FAIL   | Failed jobs                    | Red                  |
| DELAY  | Delayed jobs                   | Mauve                |
| ENQ    | Jobs enqueued per minute       | Teal                 |
| DEQ    | Jobs dequeued per minute       | Peach                |

## Development

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

BullMQ Dash uses the [Catppuccin Mocha](https://catppuccin.com/) color palette for a modern, easy-on-the-eyes aesthetic:

- **Base**: `#1e1e2e` - Main background
- **Text**: `#cdd6f4` - Primary text
- **Green**: `#a6e3a1` - Active/success states
- **Yellow**: `#f9e2af` - Waiting/warning states
- **Blue**: `#89b4fa` - Completed/info states
- **Red**: `#f38ba8` - Failed/error states
- **Mauve**: `#cba6f7` - Delayed jobs
- **Teal**: `#94e2d5` - Enqueue rate
- **Peach**: `#fab387` - Dequeue rate

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

[quanghuynt14](https://github.com/quanghuynt14)

## Related Projects

- [BullMQ](https://bullmq.io/) - Premium Message Queue for Node.js
- [Bull Board](https://github.com/felixmosh/bull-board) - Web-based dashboard for BullMQ
