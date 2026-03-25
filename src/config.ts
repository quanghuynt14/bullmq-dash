import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseArgs } from "util";
import { writeError } from "./errors.js";

const configSchema = z.object({
  redis: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().int().positive().default(6379),
    password: z.string().optional(),
    db: z.coerce.number().int().min(0).default(0),
  }),
  pollInterval: z.coerce.number().int().positive().default(3000),
  prefix: z.string().default("bull"),
  queueNames: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof configSchema>;

// ── Subcommand types ────────────────────────────────────────────────────

export type Subcommand =
  | { kind: "queues-list" }
  | { kind: "jobs-list"; queue: string; jobState?: string; pageSize?: number }
  | { kind: "jobs-get"; queue: string; jobId: string }
  | { kind: "schedulers-list"; queue: string; pageSize?: number }
  | { kind: "schedulers-get"; queue: string; schedulerId: string };

export interface CliArgs {
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
  pollInterval?: number;
  prefix?: string;
  queues?: string[];
  help?: boolean;
  version?: boolean;
  tui?: boolean;
  subcommand?: Subcommand;
  humanFriendly?: boolean;
}

let packageVersion: string | null = null;

const HELP_TEXT = `
bullmq-dash - Terminal UI dashboard for BullMQ queue monitoring

Usage:
  bullmq-dash --tui [options]                            Launch interactive TUI
  bullmq-dash <command> [options]                        Headless JSON output

Commands:
  queues list                            List all queues with job counts
  jobs list <queue>                      List jobs in a queue
  jobs get <queue> <job-id>              Get full detail for a single job
  schedulers list <queue>                List schedulers in a queue
  schedulers get <queue> <scheduler-id>  Get detail for a single scheduler

Run 'bullmq-dash <command> --help' for command-specific help.

Connection Options (all commands):
  --redis-host <host>      Redis host (default: localhost)
  --redis-port <port>      Redis port (default: 6379)
  --redis-password <pass>  Redis password
  --redis-db <db>          Redis database number (default: 0)
  --prefix <prefix>        BullMQ key prefix (default: bull)

Output Options:
  --human-friendly         Output as readable tables instead of JSON

TUI Options:
  --tui                    Launch interactive terminal dashboard
  --poll-interval <ms>     Polling interval in ms (default: 3000)
  --queues <names>         Comma-separated queue names to monitor

General:
  -v, --version            Show version
  -h, --help               Show this help message

Examples:
  bullmq-dash --tui --redis-host 192.168.1.100 --redis-port 6380
  bullmq-dash queues list --redis-host localhost
  bullmq-dash queues list --redis-host localhost --human-friendly
  bullmq-dash jobs list email --redis-host localhost --job-state failed
  bullmq-dash jobs get email 123 --redis-host localhost
`;

// ── Per-subcommand help text ────────────────────────────────────────────

const CONNECTION_OPTIONS_HELP = `
Connection Options:
  --redis-host <host>      Redis host (required)
  --redis-port <port>      Redis port (default: 6379)
  --redis-password <pass>  Redis password
  --redis-db <db>          Redis database number (default: 0)
  --prefix <prefix>        BullMQ key prefix (default: bull)

Output Options:
  --human-friendly         Output as readable tables instead of JSON`;

const QUEUES_HELP = `
Usage: bullmq-dash queues <action> [options]

Actions:
  list    List all queues with job counts

Run 'bullmq-dash queues list --help' for action-specific help.
`;

const QUEUES_LIST_HELP = `
Usage: bullmq-dash queues list [options]

List all discovered queues with their job counts per state.
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash queues list --redis-host localhost
  bullmq-dash queues list --redis-host localhost --redis-port 6380
  bullmq-dash queues list --redis-host localhost | jq '.queues[] | select(.counts.failed > 0)'
`;

const JOBS_HELP = `
Usage: bullmq-dash jobs <action> <queue> [options]

Actions:
  list <queue>             List jobs in a queue
  get <queue> <job-id>     Get full detail for a single job

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
  bullmq-dash jobs list email --redis-host localhost
  bullmq-dash jobs list email --redis-host localhost --job-state failed
  bullmq-dash jobs list email --redis-host localhost --page-size 50
  bullmq-dash jobs list email --redis-host localhost --job-state failed | jq '.jobs[] | {id, name}'
`;

const JOBS_GET_HELP = `
Usage: bullmq-dash jobs get <queue> <job-id> [options]

Get full detail for a single job including data, options, stacktrace, and timing.
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash jobs get email 123 --redis-host localhost
  bullmq-dash jobs get email 123 --redis-host localhost | jq '.job.stacktrace'
  bullmq-dash jobs get email 123 --redis-host localhost | jq '.job.data'
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
  bullmq-dash schedulers list email --redis-host localhost
  bullmq-dash schedulers list email --redis-host localhost --page-size 50
  bullmq-dash schedulers list email --redis-host localhost | jq '.schedulers[] | {key, pattern, next}'
`;

const SCHEDULERS_GET_HELP = `
Usage: bullmq-dash schedulers get <queue> <scheduler-id> [options]

Get full detail for a single scheduler including next job, recent history, and template.
${CONNECTION_OPTIONS_HELP}

Examples:
  bullmq-dash schedulers get email my-cron --redis-host localhost
  bullmq-dash schedulers get email my-cron --redis-host localhost | jq '.scheduler.recentJobs'
`;

// ── Known subcommands ───────────────────────────────────────────────────

const RESOURCE_COMMANDS = new Set(["queues", "jobs", "schedulers"]);
const ACTIONS = new Set(["list", "get"]);

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
      if (action !== "list") {
        writeError(
          `Invalid action '${action}' for queues`,
          "CONFIG_ERROR",
          "Only 'queues list' is supported.",
        );
        process.exit(2);
      }
      // Action-level help: `bullmq-dash queues list --help`
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
      break;
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
      break;
    }
  }

  return undefined;
}

// ── Parse CLI flags ─────────────────────────────────────────────────────

export function parseNumericFlag(flagName: string, rawValue: string | undefined): number | undefined {
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
  return parsed;
}

export function parseCliArgs(): CliArgs {
  const rawArgv = process.argv.slice(2);
  const { positionals, flagArgv } = extractSubcommand(rawArgv);

  try {
    const { values } = parseArgs({
      args: flagArgv,
      options: {
        "redis-host": { type: "string" },
        "redis-port": { type: "string" },
        "redis-password": { type: "string" },
        "redis-db": { type: "string" },
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
      },
      strict: true,
    });

    // Parse numeric flags with validation
    const redisPort = parseNumericFlag("redis-port", values["redis-port"]);
    const redisDb = parseNumericFlag("redis-db", values["redis-db"]);
    const pollInterval = parseNumericFlag("poll-interval", values["poll-interval"]);
    const pageSize = parseNumericFlag("page-size", values["page-size"]);

    // Parse subcommand from positionals
    const subcommand = parseSubcommand(positionals, !!values.help, values["job-state"], pageSize);

    // Validate that command-specific flags are only used with the right commands
    if (values["job-state"] && (!subcommand || subcommand.kind !== "jobs-list")) {
      writeError(
        "--job-state can only be used with 'jobs list'",
        "CONFIG_ERROR",
        "Usage: jobs list <queue> --job-state <state>",
      );
      process.exit(2);
    }

    if (
      values["page-size"] &&
      (!subcommand || (subcommand.kind !== "jobs-list" && subcommand.kind !== "schedulers-list"))
    ) {
      writeError(
        "--page-size can only be used with 'jobs list' or 'schedulers list'",
        "CONFIG_ERROR",
        "Usage: jobs list <queue> --page-size <n>",
      );
      process.exit(2);
    }

    if (values["human-friendly"] && !subcommand) {
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

    if (values["human-friendly"] && values.tui) {
      writeError(
        "--human-friendly cannot be used with --tui",
        "CONFIG_ERROR",
        "--human-friendly is for formatting subcommand output. Use --tui alone for the dashboard.",
      );
      process.exit(2);
    }

    return {
      redisHost: values["redis-host"],
      redisPort,
      redisPassword: values["redis-password"],
      redisDb,
      pollInterval,
      prefix: values.prefix,
      queues: values.queues ? parseQueueNames(values.queues) : undefined,
      help: values.help,
      version: values.version,
      tui: values.tui,
      subcommand,
      humanFriendly: values["human-friendly"],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unknown option")) {
      writeError(error.message, "CONFIG_ERROR", "Use --help to see available options.");
      process.exit(2);
    }
    throw error;
  }
}

export function showHelp(): void {
  console.log(HELP_TEXT);
  process.exit(0);
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
 * Check if Redis host is configured via CLI args
 */
export function hasRedisHostConfig(cliArgs: CliArgs): boolean {
  return !!cliArgs.redisHost;
}

/**
 * Load config with priority: CLI args > defaults
 */
export function loadConfig(cliArgs: CliArgs): Config {
  const raw = {
    redis: {
      host: cliArgs.redisHost,
      port: cliArgs.redisPort,
      password: cliArgs.redisPassword,
      db: cliArgs.redisDb,
    },
    pollInterval: cliArgs.pollInterval,
    prefix: cliArgs.prefix,
    queueNames: cliArgs.queues,
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
 * Create config from interactive prompt answers
 */
export function createConfigFromPrompt(
  promptAnswers: { host: string; port: number; password?: string },
  cliArgs: CliArgs,
): Config {
  const raw = {
    redis: {
      host: promptAnswers.host,
      port: promptAnswers.port,
      password: promptAnswers.password,
      db: cliArgs.redisDb,
    },
    pollInterval: cliArgs.pollInterval,
    prefix: cliArgs.prefix,
    queueNames: cliArgs.queues,
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.flatten();
    writeError("Configuration error", "CONFIG_ERROR", JSON.stringify(errors));
    process.exit(2);
  }

  return result.data;
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
