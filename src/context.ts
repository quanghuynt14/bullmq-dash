import { Database } from "bun:sqlite";
import Redis from "ioredis";
import type { Queue } from "bullmq";
import type { Config } from "./config.js";
import { createSqliteDb } from "./data/sqlite.js";

/**
 * Process state bundle threaded through the data layer.
 *
 * Built once at startup (`createContext(config)`) and passed as the first
 * argument to every function in `src/data/*.ts`. Replaces the family of
 * module-level singletons (`getConfig`, `getRedisClient`, `getSqliteDb`,
 * the queue cache in `queues.ts`) — see ADR-0002.
 */
export interface Context {
  config: Config;
  redis: Redis;
  db: Database;
  queueCache: Map<string, Queue>;
}

export interface CreateContextOptions {
  /** Override the default SQLite path (used by tests). */
  dbPath?: string;
}

export function createContext(config: Config, opts: CreateContextOptions = {}): Context {
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    username: config.redis.username,
    password: config.redis.password,
    db: config.redis.db,
    ...(config.redis.tls ? { tls: {} } : {}),
    lazyConnect: true,
    retryStrategy: (times) => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

  const db = createSqliteDb(config, opts.dbPath);

  return {
    config,
    redis,
    db,
    queueCache: new Map(),
  };
}
