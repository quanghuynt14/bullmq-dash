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

export interface Config {
  redis: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db: number;
    tls?: boolean;
  };
  pollInterval: number;
  prefix: string;
  queueNames?: string[];
  retentionMs: number;
}

function coercePositiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

function coerceNonNegativeInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) return null;
  return numberValue;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function validateConfig(raw: {
  redis: Record<string, unknown>;
  pollInterval?: unknown;
  prefix?: unknown;
  queueNames?: unknown;
  retentionMs?: unknown;
}): { success: true; data: Config } | { success: false; errors: string[] } {
  const errors: string[] = [];
  const redis = raw.redis;

  const host = optionalString(redis.host) ?? "localhost";
  if (host === null) errors.push("redis.host must be a string");

  const port = coercePositiveInt(redis.port, 6379);
  if (port === null) errors.push("redis.port must be a positive integer");

  const username = optionalString(redis.username);
  if (username === null) errors.push("redis.username must be a string");

  const password = optionalString(redis.password);
  if (password === null) errors.push("redis.password must be a string");

  const db = coerceNonNegativeInt(redis.db, 0);
  if (db === null) errors.push("redis.db must be a non-negative integer");

  const tls = redis.tls;
  if (tls !== undefined && typeof tls !== "boolean") {
    errors.push("redis.tls must be a boolean");
  }

  const pollInterval = coercePositiveInt(raw.pollInterval, 3000);
  if (pollInterval === null) errors.push("pollInterval must be a positive integer");

  const prefix = optionalString(raw.prefix) ?? "bull";
  if (prefix === null) errors.push("prefix must be a string");

  const queueNames = raw.queueNames;
  if (
    queueNames !== undefined &&
    (!Array.isArray(queueNames) || queueNames.some((name) => typeof name !== "string"))
  ) {
    errors.push("queueNames must be an array of strings");
  }

  const retentionMs = coercePositiveInt(raw.retentionMs, DEFAULT_RETENTION_MS);
  if (retentionMs === null) errors.push("retentionMs must be a positive integer");

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const config: Config = {
    redis: {
      host: host as string,
      port: port as number,
      db: db as number,
    },
    pollInterval: pollInterval as number,
    prefix: prefix as string,
    retentionMs: retentionMs as number,
  };

  if (username !== undefined && username !== null) config.redis.username = username;
  if (password !== undefined && password !== null) config.redis.password = password;
  if (tls !== undefined) config.redis.tls = tls as boolean;
  if (queueNames !== undefined) config.queueNames = queueNames as string[];

  return { success: true, data: config };
}

/**
 * Build a runtime Config from a single source URL (CLI wins over profile),
 * parsed into the discrete shape that BullMQ's Redis connection consumes.
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

  const result = validateConfig(raw);

  if (!result.success) {
    writeError("Configuration error", "CONFIG_ERROR", JSON.stringify(result.errors));
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
