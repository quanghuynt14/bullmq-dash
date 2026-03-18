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
  json?: boolean;
  watch?: boolean;
}

let packageVersion: string | null = null;

const HELP_TEXT = `
bullmq-dash - Terminal UI dashboard for BullMQ queue monitoring

Usage: bullmq-dash [options]

Options:
  --redis-host <host>      Redis host (default: localhost)   [env: REDIS_HOST]
  --redis-port <port>      Redis port (default: 6379)        [env: REDIS_PORT]
  --redis-password <pass>  Redis password                    [env: REDIS_PASSWORD]
  --redis-db <db>          Redis database number (default: 0)[env: REDIS_DB]
  --poll-interval <ms>     Polling interval in ms (default: 3000) [env: POLL_INTERVAL]
  --prefix <prefix>        BullMQ key prefix (default: bull) [env: BULLMQ_PREFIX]
  --queues <names>         Comma-separated queue names       [env: QUEUES]
  --json                   Output a JSON snapshot and exit (headless/agent mode)
  --watch                  Stream NDJSON snapshots (use with --json)
  -v, --version            Show version
  -h, --help               Show this help message

CLI flags take priority over environment variables.

Examples:
  bullmq-dash
  bullmq-dash --redis-host 192.168.1.100 --redis-port 6380
  bullmq-dash --queues email,notifications
  bullmq-dash --prefix bull:taskService
  bullmq-dash --json --redis-host localhost
  bullmq-dash --json --watch --redis-host localhost
  REDIS_HOST=localhost bullmq-dash --json
`;

export function parseCliArgs(): CliArgs {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
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
        json: { type: "boolean" },
        watch: { type: "boolean" },
      },
      strict: true,
    });

    // CLI flags take priority over environment variables
    const redisPortRaw = values["redis-port"] ?? process.env.REDIS_PORT;
    const redisDbRaw = values["redis-db"] ?? process.env.REDIS_DB;
    const pollIntervalRaw = values["poll-interval"] ?? process.env.POLL_INTERVAL;

    return {
      redisHost: values["redis-host"] ?? process.env.REDIS_HOST,
      redisPort: redisPortRaw ? parseInt(String(redisPortRaw), 10) : undefined,
      redisPassword: values["redis-password"] ?? process.env.REDIS_PASSWORD,
      redisDb: redisDbRaw ? parseInt(String(redisDbRaw), 10) : undefined,
      pollInterval: pollIntervalRaw ? parseInt(String(pollIntervalRaw), 10) : undefined,
      prefix: values.prefix ?? process.env.BULLMQ_PREFIX,
      queues: values.queues
        ? parseQueueNames(values.queues)
        : parseQueueNames(process.env.QUEUES),
      help: values.help,
      version: values.version,
      json: values.json,
      watch: values.watch,
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
 * Check if Redis host is configured from any source (CLI args or env vars)
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
