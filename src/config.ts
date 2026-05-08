import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseArgs } from "util";
import { writeError } from "./errors.js";
import { parseDuration, MAX_RETRY_PAGE_SIZE } from "./data/duration.js";
import { parseRedisUrl, type ParsedRedisUrl, type ResolvedProfile } from "./profiles.js";

const configSchema = z.object({
  redis: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().int().positive().default(6379),
    username: z.string().optional(),
    password: z.string().optional(),
    db: z.coerce.number().int().min(0).default(0),
    tls: z.boolean().optional(),
  }),
  pollInterval: z.coerce.number().int().positive().default(3000),
  prefix: z.string().default("bull"),
  queueNames: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof configSchema>;

// ── Subcommand types ────────────────────────────────────────────────────

export type Subcommand =
  | { kind: "queues-list" }
  | { kind: "queues-delete"; queue: string; dryRun?: boolean; yes?: boolean }
  | { kind: "jobs-list"; queue: string; jobState?: string; pageSize?: number }
  | { kind: "jobs-get"; queue: string; jobId: string }
  | {
      kind: "jobs-retry";
      queue: string;
      jobState: string;
      since?: string;
      name?: string;
      pageSize?: number;
      dryRun: boolean;
    }
  | { kind: "schedulers-list"; queue: string; pageSize?: number }
  | { kind: "schedulers-get"; queue: string; schedulerId: string };

export interface CliArgs {
  redisUrl?: string;
  pollInterval?: number;
  prefix?: string;
  queues?: string[];
  help?: boolean;
  version?: boolean;
  tui?: boolean;
  subcommand?: Subcommand;
  humanFriendly?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  profile?: string;
  configPath?: string;
}

let packageVersion: string | null = null;

const HELP_TEXT = `
bullmq-dash - Terminal UI dashboard for BullMQ queue monitoring

Usage:
  bullmq-dash --tui [options]                            Launch interactive TUI
  bullmq-dash <command> [options]                        Headless JSON output

Commands:
  queues list                            List all queues with job counts
  queues delete <queue>                  Delete a queue and all its jobs
  jobs list <queue>                      List jobs in a queue
  jobs get <queue> <job-id>              Get full detail for a single job
  jobs retry <queue>                     Bulk-retry failed jobs (supports --dry-run)
  schedulers list <queue>                List schedulers in a queue
  schedulers get <queue> <scheduler-id>  Get detail for a single scheduler

Run 'bullmq-dash <command> --help' for command-specific help.

Connection Options (all commands):
  --profile <name>         Use a named profile from the config file
  --config <path>          Path to config file
                           (default: ~/.config/bullmq-dash/config.json)
  --redis-url <url>        Full connection URL: redis://[user:pass@]host[:port][/db]
                           (rediss:// for TLS)
  --prefix <prefix>        BullMQ key prefix (default: bull)

Output Options:
  --human-friendly         Human-readable table output (default: JSON)

TUI Options:
  --tui                    Launch interactive terminal dashboard
  --poll-interval <ms>     Polling interval in ms (default: 3000)
  --queues <names>         Comma-separated queue names to monitor

General:
  -v, --version            Show version
  -h, --help               Show this help message

Examples:
  bullmq-dash --tui --redis-url redis://localhost:6379
  bullmq-dash --tui --redis-url redis://user:pass@redis.example.com:6379/0
  bullmq-dash --tui --profile prod
  bullmq-dash queues list --redis-url redis://localhost:6379
  bullmq-dash queues list --profile prod
  bullmq-dash queues list --redis-url redis://localhost --human-friendly
  bullmq-dash jobs list email --redis-url redis://localhost --job-state failed
  bullmq-dash jobs get email 123 --redis-url redis://localhost
  bullmq-dash jobs retry email --redis-url redis://localhost --job-state failed --since 1h --dry-run
`;

// ── Per-subcommand help text ────────────────────────────────────────────

const CONNECTION_OPTIONS_HELP = `
Connection Options:
  --profile <name>         Use a named profile from the config file
  --config <path>          Path to config file
                           (default: ~/.config/bullmq-dash/config.json)
  --redis-url <url>        Full connection URL (required unless provided via profile)
                           Format: redis://[user:pass@]host[:port][/db]
                           Use rediss:// for TLS.
  --prefix <prefix>        BullMQ key prefix (default: bull)

Output Options:
  --human-friendly         Human-readable table output (default: JSON)`;

const QUEUES_HELP = `
Usage: bullmq-dash queues <action> [options]

Actions:
  list                       List all queues with job counts
  delete <queue>              Permanently delete a queue and all its jobs

Run 'bullmq-dash queues <action> --help' for action-specific help.
`;

const QUEUES_LIST_HELP = `
Usage: bullmq-dash queues list [options]

List all discovered queues with their job counts per state.
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash queues list --redis-url redis://localhost
  bullmq-dash queues list --redis-url redis://localhost:6380
  bullmq-dash queues list --redis-url redis://localhost | jq '.queues[] | select(.counts.failed > 0)'
`;

const QUEUES_DELETE_HELP = `
Usage: bullmq-dash queues delete <queue> [options]

Permanently delete a queue and all its jobs from Redis.

Options:
  --dry-run               Preview what would be deleted without making changes
  --yes                   Skip confirmation prompt (for scripting)
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash queues delete email --redis-url redis://localhost
  bullmq-dash queues delete email --redis-url redis://localhost --dry-run
  bullmq-dash queues delete email --redis-url redis://localhost --yes
`;

const JOBS_HELP = `
Usage: bullmq-dash jobs <action> <queue> [options]

Actions:
  list <queue>             List jobs in a queue
  get <queue> <job-id>     Get full detail for a single job
  retry <queue>            Bulk-retry failed jobs (supports --dry-run)

Run 'bullmq-dash jobs <action> --help' for action-specific help.
`;

const JOBS_LIST_HELP = `
Usage: bullmq-dash jobs list <queue> [options]

List jobs in a queue. Returns up to 1000 jobs by default, sorted by timestamp.

Options:
  --job-state <state>      Filter by state: wait | active | completed | failed | delayed
  --page-size <n>          Max results to return (default: 1000)
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash jobs list email --redis-url redis://localhost
  bullmq-dash jobs list email --redis-url redis://localhost --job-state failed
  bullmq-dash jobs list email --redis-url redis://localhost --page-size 50
  bullmq-dash jobs list email --redis-url redis://localhost --job-state failed | jq '.jobs[] | {id, name}'
`;

const JOBS_GET_HELP = `
Usage: bullmq-dash jobs get <queue> <job-id> [options]

Get full detail for a single job including data, options, stacktrace, and timing.
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash jobs get email 123 --redis-url redis://localhost
  bullmq-dash jobs get email 123 --redis-url redis://localhost | jq '.job.stacktrace'
  bullmq-dash jobs get email 123 --redis-url redis://localhost | jq '.job.data'
`;

const JOBS_RETRY_HELP = `
Usage: bullmq-dash jobs retry <queue> --job-state failed [options]

Bulk-retry failed jobs in a queue. Operates on failed jobs only in v1.
Always use --dry-run first to see what would be retried.

Required:
  --job-state failed       Must be 'failed' (other states not supported in v1)

Filters:
  --since <duration>       Only jobs that failed within this window.
                           Formats: 30s | 5m | 1h | 24h | 7d
  --name <exact>           Only jobs whose name exactly matches this string
  --page-size <n>          Max jobs to consider (default: 1000, max: 10000)

Safety:
  --dry-run                Show what WOULD be retried without enqueueing anything.
                           Prints matched count and sample job IDs.

Exit codes:
  0  Success (dry-run complete, or all matched jobs retried). Includes empty-match.
  1  Runtime / fetch error (e.g. Redis connection failed)
  2  Config error (invalid flags, missing --job-state, --page-size > 10000)
  3  Partial failure — some jobs retried, some errored (see errors[])

${CONNECTION_OPTIONS_HELP}

Examples:
  # Always start with a dry-run
  bullmq-dash jobs retry payments --redis-url redis://localhost --job-state failed --since 1h --dry-run

  # Then retry for real
  bullmq-dash jobs retry payments --redis-url redis://localhost --job-state failed --since 1h

  # Filter by job name
  bullmq-dash jobs retry email --redis-url redis://localhost --job-state failed --name welcome-email --dry-run

  # Pipe dry-run output through jq to extract sample IDs
  bullmq-dash jobs retry payments --redis-url redis://localhost --job-state failed --since 24h --dry-run | jq '.sampleJobIds'
`;

const SCHEDULERS_HELP = `
Usage: bullmq-dash schedulers <action> <queue> [options]

Actions:
  list <queue>                  List schedulers in a queue
  get <queue> <scheduler-id>   Get detail for a single scheduler

Run 'bullmq-dash schedulers <action> --help' for action-specific help.
`;

const SCHEDULERS_LIST_HELP = `
Usage: bullmq-dash schedulers list <queue> [options]

List all job schedulers in a queue with their cron patterns and next run times.

Options:
  --page-size <n>          Max results to return (default: 1000)
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash schedulers list email --redis-url redis://localhost
  bullmq-dash schedulers list email --redis-url redis://localhost --page-size 50
  bullmq-dash schedulers list email --redis-url redis://localhost | jq '.schedulers[] | {key, pattern, next}'
`;

const SCHEDULERS_GET_HELP = `
Usage: bullmq-dash schedulers get <queue> <scheduler-id> [options]

Get full detail for a single scheduler including next job, recent history, and template.
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash schedulers get email my-cron --redis-url redis://localhost
  bullmq-dash schedulers get email my-cron --redis-url redis://localhost | jq '.scheduler.recentJobs'
`;

// ── Known subcommands ───────────────────────────────────────────────────

const RESOURCE_COMMANDS = new Set(["queues", "jobs", "schedulers"]);
const ACTIONS = new Set(["list", "get", "retry", "delete"]);

/**
 * Separate subcommand tokens (positional args) from flag tokens.
 * Returns the subcommand positionals and the remaining argv for parseArgs.
 */
export function extractSubcommand(argv: string[]): { positionals: string[]; flagArgv: string[] } {
  const positionals: string[] = [];
  const flagArgv: string[] = [];
  let donePositionals = false;

  for (let i = 0; i < argv.length; i++) {
    if (donePositionals) {
      flagArgv.push(argv[i]!);
      continue;
    }

    const arg = argv[i]!;

    // If it starts with '-', it's a flag — everything from here is flags
    if (arg.startsWith("-")) {
      donePositionals = true;
      flagArgv.push(arg);
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flagArgv };
}

// ── Parse subcommand from positionals ───────────────────────────────────

/**
 * Show help text and exit. Used for per-subcommand --help.
 */
function showSubcommandHelp(text: string): never {
  console.log(text);
  process.exit(0);
}

function parseSubcommand(
  positionals: string[],
  help: boolean,
  jobState: string | undefined,
  pageSize: number | undefined,
  since: string | undefined,
  name: string | undefined,
  dryRun: boolean,
  yes: boolean = false,
): Subcommand | undefined {
  if (positionals.length === 0) return undefined;

  const resource = positionals[0]!;
  const action = positionals[1];

  if (!RESOURCE_COMMANDS.has(resource)) {
    writeError(
      `Unknown command: '${resource}'`,
      "CONFIG_ERROR",
      `Available commands: queues, jobs, schedulers. Use --help for usage.`,
    );
    process.exit(2);
  }

  // Resource-level help: e.g. `bullmq-dash jobs --help`
  if (help && !action) {
    switch (resource) {
      case "queues":
        showSubcommandHelp(QUEUES_HELP);
        break;
      case "jobs":
        showSubcommandHelp(JOBS_HELP);
        break;
      case "schedulers":
        showSubcommandHelp(SCHEDULERS_HELP);
        break;
    }
  }

  if (!action || !ACTIONS.has(action)) {
    writeError(
      `Missing or invalid action for '${resource}'`,
      "CONFIG_ERROR",
      `Expected: ${resource} list or ${resource} get. Use --help for usage.`,
    );
    process.exit(2);
  }

  switch (resource) {
    case "queues": {
      if (action === "list") {
        if (help) showSubcommandHelp(QUEUES_LIST_HELP);
        if (positionals.length > 2) {
          writeError(
            `Unexpected arguments: ${positionals.slice(2).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: queues list [options]",
          );
          process.exit(2);
        }
        return { kind: "queues-list" };
      }
      if (action === "delete") {
        if (help) showSubcommandHelp(QUEUES_DELETE_HELP);
        const queue = positionals[2];
        if (!queue) {
          writeError(
            "Missing required argument: <queue>",
            "CONFIG_ERROR",
            "Usage: queues delete <queue> [--dry-run] [--yes]",
          );
          process.exit(2);
        }
        if (positionals.length > 3) {
          writeError(
            `Unexpected arguments: ${positionals.slice(3).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: queues delete <queue> [--dry-run] [--yes]",
          );
          process.exit(2);
        }
        return { kind: "queues-delete", queue, dryRun, yes };
      }
      writeError(
        `Invalid action '${action}' for queues`,
        "CONFIG_ERROR",
        "Available actions: list, delete. Use --help for usage.",
      );
      process.exit(2);
    }

    case "jobs": {
      if (action === "list") {
        // Action-level help: `bullmq-dash jobs list --help`
        if (help) showSubcommandHelp(JOBS_LIST_HELP);
        const queue = positionals[2];
        if (!queue) {
          writeError(
            "Missing required argument: <queue>",
            "CONFIG_ERROR",
            "Usage: jobs list <queue> [--job-state <state>] [--page-size <n>]",
          );
          process.exit(2);
        }
        if (positionals.length > 3) {
          writeError(
            `Unexpected arguments: ${positionals.slice(3).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: jobs list <queue> [--job-state <state>] [--page-size <n>]",
          );
          process.exit(2);
        }
        return { kind: "jobs-list", queue, jobState, pageSize };
      }
      if (action === "get") {
        // Action-level help: `bullmq-dash jobs get --help`
        if (help) showSubcommandHelp(JOBS_GET_HELP);
        const queue = positionals[2];
        const jobId = positionals[3];
        if (!queue || !jobId) {
          writeError(
            "Missing required arguments: <queue> <job-id>",
            "CONFIG_ERROR",
            "Usage: jobs get <queue> <job-id>",
          );
          process.exit(2);
        }
        if (positionals.length > 4) {
          writeError(
            `Unexpected arguments: ${positionals.slice(4).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: jobs get <queue> <job-id>",
          );
          process.exit(2);
        }
        return { kind: "jobs-get", queue, jobId };
      }
      if (action === "retry") {
        // Action-level help: `bullmq-dash jobs retry --help`
        if (help) showSubcommandHelp(JOBS_RETRY_HELP);
        const queue = positionals[2];
        if (!queue) {
          writeError(
            "Missing required argument: <queue>",
            "CONFIG_ERROR",
            "Usage: jobs retry <queue> --job-state failed [--since <duration>] [--name <pattern>] [--dry-run]",
          );
          process.exit(2);
        }
        if (positionals.length > 3) {
          writeError(
            `Unexpected arguments: ${positionals.slice(3).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: jobs retry <queue> --job-state failed [options]",
          );
          process.exit(2);
        }
        // Retry only operates on failed jobs. Guard against footguns.
        if (!jobState) {
          writeError(
            "--job-state is required for 'jobs retry'",
            "CONFIG_ERROR",
            "Use --job-state failed. Other states are not currently supported.",
          );
          process.exit(2);
        }
        if (jobState !== "failed") {
          writeError(
            `Unsupported --job-state '${jobState}' for 'jobs retry'`,
            "CONFIG_ERROR",
            "Only --job-state failed is currently supported.",
          );
          process.exit(2);
        }
        return { kind: "jobs-retry", queue, jobState, since, name, pageSize, dryRun };
      }
      writeError(
        `Invalid action '${action}' for jobs`,
        "CONFIG_ERROR",
        "Available actions: list, get, retry. Use --help for usage.",
      );
      process.exit(2);
    }

    case "schedulers": {
      if (action === "list") {
        // Action-level help: `bullmq-dash schedulers list --help`
        if (help) showSubcommandHelp(SCHEDULERS_LIST_HELP);
        const queue = positionals[2];
        if (!queue) {
          writeError(
            "Missing required argument: <queue>",
            "CONFIG_ERROR",
            "Usage: schedulers list <queue> [--page-size <n>]",
          );
          process.exit(2);
        }
        if (positionals.length > 3) {
          writeError(
            `Unexpected arguments: ${positionals.slice(3).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: schedulers list <queue> [--page-size <n>]",
          );
          process.exit(2);
        }
        return { kind: "schedulers-list", queue, pageSize };
      }
      if (action === "get") {
        // Action-level help: `bullmq-dash schedulers get --help`
        if (help) showSubcommandHelp(SCHEDULERS_GET_HELP);
        const queue = positionals[2];
        const schedulerId = positionals[3];
        if (!queue || !schedulerId) {
          writeError(
            "Missing required arguments: <queue> <scheduler-id>",
            "CONFIG_ERROR",
            "Usage: schedulers get <queue> <scheduler-id>",
          );
          process.exit(2);
        }
        if (positionals.length > 4) {
          writeError(
            `Unexpected arguments: ${positionals.slice(4).join(" ")}`,
            "CONFIG_ERROR",
            "Usage: schedulers get <queue> <scheduler-id>",
          );
          process.exit(2);
        }
        return { kind: "schedulers-get", queue, schedulerId };
      }
      writeError(
        `Invalid action '${action}' for schedulers`,
        "CONFIG_ERROR",
        "Available actions: list, get. Use --help for usage.",
      );
      process.exit(2);
    }
  }

  return undefined;
}

// ── Parse CLI flags ─────────────────────────────────────────────────────

export function parseNumericFlag(
  flagName: string,
  rawValue: string | undefined,
  options?: { min?: number },
): number | undefined {
  if (!rawValue) return undefined;
  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    writeError(
      `Invalid value for --${flagName}`,
      "CONFIG_ERROR",
      `Expected a valid number, got "${rawValue}"`,
    );
    process.exit(2);
  }
  if (options?.min !== undefined && parsed < options.min) {
    writeError(
      `Invalid value for --${flagName}`,
      "CONFIG_ERROR",
      `Expected a number >= ${options.min}, got ${parsed}`,
    );
    process.exit(2);
  }
  return parsed;
}

export function parseCliArgs(): CliArgs {
  const rawArgv = process.argv.slice(2);
  const { positionals, flagArgv } = extractSubcommand(rawArgv);

  try {
    const { values } = parseArgs({
      args: flagArgv,
      options: {
        "redis-url": { type: "string" },
        "poll-interval": { type: "string" },
        prefix: { type: "string" },
        queues: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        tui: { type: "boolean" },
        // Command-specific flags
        "job-state": { type: "string" },
        "page-size": { type: "string" },
        "human-friendly": { type: "boolean" },
        // jobs retry flags
        since: { type: "string" },
        name: { type: "string" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean" },
        // Profiles / config file
        profile: { type: "string" },
        config: { type: "string" },
      },
      strict: true,
    });

    // Parse numeric flags with validation
    const pollInterval = parseNumericFlag("poll-interval", values["poll-interval"]);
    const pageSize = parseNumericFlag("page-size", values["page-size"], { min: 1 });

    const humanFriendly = values["human-friendly"] ?? false;
    const since = values.since;
    const nameFilter = values.name;
    const dryRun = values["dry-run"] ?? false;
    const yes = values.yes ?? false;

    // Validate the URL itself eagerly so bad input fails fast with CONFIG_ERROR
    // instead of an opaque ioredis error during connect.
    if (values["redis-url"] !== undefined) {
      try {
        parseRedisUrl(values["redis-url"]);
      } catch (error) {
        writeError(
          "Invalid --redis-url",
          "CONFIG_ERROR",
          error instanceof Error ? error.message : String(error),
        );
        process.exit(2);
      }
    }

    // Validate --since format at parse time so bad input fails fast with exit 2
    // (CONFIG_ERROR) instead of exit 1 (runtime error) deeper in the fetch path.
    if (since !== undefined && parseDuration(since) === null) {
      writeError(
        `Invalid --since value '${since}'`,
        "CONFIG_ERROR",
        "Expected format: 30s, 5m, 1h, 24h, 7d. Must be a positive integer followed by s/m/h/d.",
      );
      process.exit(2);
    }

    // Parse subcommand from positionals FIRST, then validate pageSize cap
    const subcommand = parseSubcommand(
      positionals,
      !!values.help,
      values["job-state"],
      pageSize,
      since,
      nameFilter,
      dryRun,
      yes ?? false,
    );

    // Safety rail against accidental multi-million-job retries. Only applies to
    // jobs-retry — queues-delete doesn't accept --page-size (gated below).
    if (
      subcommand?.kind === "jobs-retry" &&
      pageSize !== undefined &&
      pageSize > MAX_RETRY_PAGE_SIZE
    ) {
      writeError(
        `--page-size exceeds ${MAX_RETRY_PAGE_SIZE}`,
        "CONFIG_ERROR",
        `--page-size is capped at ${MAX_RETRY_PAGE_SIZE}. For larger batches, run multiple passes with narrower filters (--since, --name).`,
      );
      process.exit(2);
    }

    // Validate that command-specific flags are only used with the right commands
    if (
      values["job-state"] &&
      (!subcommand || (subcommand.kind !== "jobs-list" && subcommand.kind !== "jobs-retry"))
    ) {
      writeError(
        "--job-state can only be used with 'jobs list' or 'jobs retry'",
        "CONFIG_ERROR",
        "Usage: jobs list <queue> --job-state <state>  or  jobs retry <queue> --job-state failed",
      );
      process.exit(2);
    }

    if (
      values["page-size"] &&
      (!subcommand ||
        (subcommand.kind !== "jobs-list" &&
          subcommand.kind !== "jobs-retry" &&
          subcommand.kind !== "schedulers-list"))
    ) {
      writeError(
        "--page-size can only be used with 'jobs list', 'jobs retry', or 'schedulers list'",
        "CONFIG_ERROR",
        "Usage: jobs list <queue> --page-size <n>",
      );
      process.exit(2);
    }

    if (values.since && (!subcommand || subcommand.kind !== "jobs-retry")) {
      writeError(
        "--since can only be used with 'jobs retry'",
        "CONFIG_ERROR",
        "Usage: jobs retry <queue> --job-state failed --since 1h",
      );
      process.exit(2);
    }

    if (values.name && (!subcommand || subcommand.kind !== "jobs-retry")) {
      writeError(
        "--name can only be used with 'jobs retry'",
        "CONFIG_ERROR",
        "Usage: jobs retry <queue> --job-state failed --name <pattern>",
      );
      process.exit(2);
    }

    if (humanFriendly && !subcommand) {
      writeError(
        "--human-friendly can only be used with subcommands",
        "CONFIG_ERROR",
        "Usage: bullmq-dash <command> --human-friendly. Use --help for usage.",
      );
      process.exit(2);
    }

    if (values.tui && subcommand) {
      writeError(
        "--tui cannot be used with subcommands",
        "CONFIG_ERROR",
        "Use --tui to launch the interactive dashboard, or use subcommands for headless output.",
      );
      process.exit(2);
    }

    if (
      dryRun &&
      (!subcommand || (subcommand.kind !== "jobs-retry" && subcommand.kind !== "queues-delete"))
    ) {
      writeError(
        "--dry-run can only be used with 'jobs retry' or 'queues delete'",
        "CONFIG_ERROR",
        "Usage: jobs retry <queue> --job-state failed --dry-run  or  queues delete <queue> --dry-run",
      );
      process.exit(2);
    }

    if (yes && (!subcommand || subcommand.kind !== "queues-delete")) {
      writeError(
        "--yes can only be used with 'queues delete'",
        "CONFIG_ERROR",
        "Usage: queues delete <queue> --yes",
      );
      process.exit(2);
    }

    if (dryRun && yes) {
      writeError(
        "--dry-run and --yes cannot be used together",
        "CONFIG_ERROR",
        "Usage: queues delete <queue> [--dry-run] or queues delete <queue> --yes",
      );
      process.exit(2);
    }

    if (humanFriendly && values.tui) {
      writeError(
        "--human-friendly cannot be used with --tui",
        "CONFIG_ERROR",
        "--human-friendly is for formatting subcommand output. Use --tui alone for the dashboard.",
      );
      process.exit(2);
    }

    return {
      redisUrl: values["redis-url"],
      pollInterval,
      prefix: values.prefix,
      queues: values.queues ? parseQueueNames(values.queues) : undefined,
      help: values.help,
      version: values.version,
      tui: values.tui,
      subcommand,
      humanFriendly,
      dryRun,
      yes,
      profile: values.profile,
      configPath: values.config,
    };
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        error.message.includes("Unknown option") ||
        code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ||
        code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
      ) {
        writeError(error.message, "CONFIG_ERROR", "Use --help to see available options.");
        process.exit(2);
      }
    }
    throw error;
  }
}

export function showHelp(exitCode: number = 0): void {
  console.log(HELP_TEXT);
  process.exit(exitCode);
}

export function showVersion(): void {
  console.log(getVersionText());
  process.exit(0);
}

export function getVersionText(): string {
  return `bullmq-dash v${getPackageVersion()}`;
}

function getPackageVersion(): string {
  if (packageVersion) {
    return packageVersion;
  }

  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf-8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error("Invalid package.json version");
  }

  packageVersion = packageJson.version;
  return packageVersion;
}

export function parseQueueNames(value: string | undefined): string[] | undefined {
  if (!value || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True if a Redis URL is reachable from either the CLI or the resolved profile.
 * Used by index.ts to decide between launching the interactive prompt (TUI)
 * and failing fast (subcommand / web modes that can't prompt).
 */
export function hasRedisHostConfig(cliArgs: CliArgs, profile?: ResolvedProfile | null): boolean {
  return !!cliArgs.redisUrl || !!profile?.profile.redis?.url;
}

/**
 * Load profiles only when the connection may come from config, or when the
 * user explicitly asked for profile/config behavior. A direct --redis-url is a
 * complete connection source and should not be blocked by stale ambient config.
 */
export function shouldLoadProfile(cliArgs: CliArgs): boolean {
  return !cliArgs.redisUrl || !!cliArgs.profile || !!cliArgs.configPath;
}

/**
 * Build a runtime Config from a single source URL (CLI wins over profile),
 * parsed into the discrete shape that ioredis / BullMQ consume internally.
 * The user-facing surface only knows about URLs; everything below this line
 * works in terms of host/port/etc. so the connection helpers don't change.
 */
export function loadConfig(cliArgs: CliArgs, profile?: ResolvedProfile | null): Config {
  const p = profile?.profile;
  const url = cliArgs.redisUrl ?? p?.redis?.url;

  let parts: ParsedRedisUrl | undefined;
  if (url) {
    try {
      parts = parseRedisUrl(url);
    } catch (error) {
      writeError(
        cliArgs.redisUrl
          ? "Invalid --redis-url"
          : `Invalid redis.url in profile '${profile?.name}'`,
        "CONFIG_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(2);
    }
  }

  const raw = {
    redis: {
      host: parts?.host,
      port: parts?.port,
      username: parts?.username,
      password: parts?.password,
      db: parts?.db,
      tls: parts?.tls,
    },
    pollInterval: cliArgs.pollInterval ?? p?.pollInterval,
    prefix: cliArgs.prefix ?? p?.prefix,
    queueNames: cliArgs.queues ?? p?.queues,
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.flatten();
    writeError("Configuration error", "CONFIG_ERROR", JSON.stringify(errors));
    process.exit(2);
  }

  return result.data;
}

/**
 * Build a runtime Config from a URL that the interactive prompt collected.
 * Same shape as loadConfig but takes a pre-validated URL string directly so
 * the prompt can show a friendlier "ok / try again" loop without coupling
 * itself to parseCliArgs.
 */
export function createConfigFromPrompt(redisUrl: string, cliArgs: CliArgs): Config {
  return loadConfig({ ...cliArgs, redisUrl });
}

// Singleton config instance
let configInstance: Config | null = null;

export function setConfig(config: Config): void {
  configInstance = config;
}

export function getConfig(): Config {
  if (!configInstance) {
    throw new Error("Config not initialized. Call setConfig() first.");
  }
  return configInstance;
}
