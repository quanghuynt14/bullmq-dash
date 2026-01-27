import { config } from "dotenv";
import { z } from "zod";
import { parseArgs } from "util";

// Load .env file
config();

const configSchema = z.object({
  redis: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().int().positive().default(6379),
    password: z.string().optional(),
    db: z.coerce.number().int().min(0).default(0),
  }),
  pollInterval: z.coerce.number().int().positive().default(3000),
  queueNames: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof configSchema>;

export interface CliArgs {
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
  pollInterval?: number;
  queues?: string[];
  help?: boolean;
  version?: boolean;
}

const VERSION = "0.1.0";

const HELP_TEXT = `
bullmq-dash - Terminal UI dashboard for BullMQ queue monitoring

Usage: bullmq-dash [options]

Options:
  --redis-host <host>      Redis host (default: localhost)
  --redis-port <port>      Redis port (default: 6379)
  --redis-password <pass>  Redis password
  --redis-db <db>          Redis database number (default: 0)
  --poll-interval <ms>     Polling interval in milliseconds (default: 3000)
  --queues <names>         Comma-separated queue names to monitor
  -v, --version            Show version
  -h, --help               Show this help message

Environment Variables:
  REDIS_HOST               Redis host
  REDIS_PORT               Redis port
  REDIS_PASSWORD           Redis password
  REDIS_DB                 Redis database number
  POLL_INTERVAL            Polling interval in milliseconds
  QUEUE_NAMES              Comma-separated queue names

Examples:
  bullmq-dash
  bullmq-dash --redis-host 192.168.1.100 --redis-port 6380
  bullmq-dash --queues email,notifications
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
        queues: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
    });

    return {
      redisHost: values["redis-host"],
      redisPort: values["redis-port"] ? parseInt(values["redis-port"], 10) : undefined,
      redisPassword: values["redis-password"],
      redisDb: values["redis-db"] ? parseInt(values["redis-db"], 10) : undefined,
      pollInterval: values["poll-interval"] ? parseInt(values["poll-interval"], 10) : undefined,
      queues: values.queues ? parseQueueNames(values.queues) : undefined,
      help: values.help,
      version: values.version,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unknown option")) {
      console.error(`Error: ${error.message}`);
      console.error("Use --help to see available options.");
      process.exit(1);
    }
    throw error;
  }
}

export function showHelp(): void {
  console.log(HELP_TEXT);
  process.exit(0);
}

export function showVersion(): void {
  console.log(`bullmq-dash v${VERSION}`);
  process.exit(0);
}

export function parseQueueNames(value: string | undefined): string[] | undefined {
  if (!value || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check if Redis host is configured from any source
 */
export function hasRedisHostConfig(cliArgs: CliArgs): boolean {
  return !!(cliArgs.redisHost || process.env.REDIS_HOST);
}

/**
 * Load config with priority: CLI args > env vars > defaults
 */
export function loadConfig(cliArgs: CliArgs): Config {
  const raw = {
    redis: {
      host: cliArgs.redisHost ?? process.env.REDIS_HOST,
      port: cliArgs.redisPort ?? process.env.REDIS_PORT,
      password: cliArgs.redisPassword ?? process.env.REDIS_PASSWORD ?? undefined,
      db: cliArgs.redisDb ?? process.env.REDIS_DB,
    },
    pollInterval: cliArgs.pollInterval ?? process.env.POLL_INTERVAL,
    queueNames: cliArgs.queues ?? parseQueueNames(process.env.QUEUE_NAMES),
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.flatten();
    console.error("Configuration error:");
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
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
      db: cliArgs.redisDb ?? process.env.REDIS_DB,
    },
    pollInterval: cliArgs.pollInterval ?? process.env.POLL_INTERVAL,
    queueNames: cliArgs.queues ?? parseQueueNames(process.env.QUEUE_NAMES),
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.flatten();
    console.error("Configuration error:");
    console.error(JSON.stringify(errors, null, 2));
    process.exit(1);
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
