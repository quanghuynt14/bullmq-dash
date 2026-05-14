import { z } from "zod";
import { writeError } from "./errors.js";
import { parseRedisUrl, type ParsedRedisUrl, type ResolvedProfile } from "./profiles.js";
import type { CliArgs } from "./cli.js";

/**
 * Default soft-delete retention window: 7 days. Soft-deleted jobs remain in
 * the SQLite cache for this long before compaction physically removes them.
 * The window bounds storage growth while leaving room for the historical-view
 * feature to surface jobs past Redis retention. (See ADR-0001.)
 */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  retentionMs: z.coerce.number().int().positive().default(DEFAULT_RETENTION_MS),
});

export type Config = z.infer<typeof configSchema>;

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
    retentionMs: p?.retentionMs,
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
