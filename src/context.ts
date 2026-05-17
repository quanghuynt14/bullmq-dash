import { Database } from "bun:sqlite";
import { RedisConnection, type Queue, type RedisClient } from "bullmq";
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
  redis: ContextRedisClient;
  db: Database;
  queueCache: Map<string, Queue>;
}

export interface ContextRedisClient {
  readonly status: string;
  connect(): Promise<void>;
  quit(): Promise<void>;
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
}

interface RedisCommands {
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
}

export interface CreateContextOptions {
  /** Override the default SQLite path (used by tests). */
  dbPath?: string;
}

function createRedisClient(config: Config): ContextRedisClient {
  let connection: RedisConnection | null = null;
  let clientPromise: Promise<RedisClient> | null = null;

  const getClient = (): Promise<RedisClient> => {
    if (!clientPromise) {
      connection = new RedisConnection(
        {
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
        },
        { blocking: false },
      );
      connection.on("error", () => {
        // Callers observe connection failures through the returned promises.
      });
      clientPromise = connection.client.catch((err) => {
        clientPromise = null;
        connection = null;
        throw err;
      });
    }
    return clientPromise;
  };

  return {
    get status(): string {
      return connection?.status ?? "wait";
    },
    async connect(): Promise<void> {
      await getClient();
    },
    async quit(): Promise<void> {
      if (!connection) return;
      await connection.close();
      connection = null;
      clientPromise = null;
    },
    async scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]> {
      const client = (await getClient()) as unknown as RedisCommands;
      return client.scan(cursor, ...args);
    },
    async del(...keys: string[]): Promise<number> {
      const client = (await getClient()) as unknown as RedisCommands;
      return client.del(...keys);
    },
  };
}

export function createContext(config: Config, opts: CreateContextOptions = {}): Context {
  const redis = createRedisClient(config);
  const db = createSqliteDb(config, opts.dbPath);

  return {
    config,
    redis,
    db,
    queueCache: new Map(),
  };
}
