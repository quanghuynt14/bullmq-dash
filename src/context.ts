import { Database } from "bun:sqlite";
import { RedisConnection, type Queue, type RedisClient } from "bullmq";
import type { Config } from "./config.js";
import { closeAllQueues } from "./data/queues.js";
import { createSqliteDb } from "./data/sqlite.js";
import { redisConnectionOptions } from "./redis-options.js";

/**
 * Process state bundle threaded through the data layer.
 *
 * Built once at startup (`createContext(config)`) and passed as the first
 * argument to every function in `src/data/*.ts`. Replaces the family of
 * module-level singletons that used to live in `config.ts`, `data/redis.ts`,
 * `data/sqlite.ts`, and `data/queues.ts` — see ADR-0002. The whole point of
 * the bundle is that *every* process-scoped piece of state lives here, so
 * two contexts in the same process don't share caches, locks, or handles.
 */
export interface Context {
  readonly config: Config;
  readonly redis: ContextRedisClient;
  readonly db: Database;
  readonly queueCache: Map<string, Queue>;
  /** Cached queue-name discovery (TTL'd in queues.ts). Reassigned, not readonly. */
  queueNamesCache: { names: string[]; timestamp: number } | null;
  /** Per-context queue-store lifecycle state. */
  readonly queueStore: QueueStoreContextState;
}

export interface QueueStoreContextState {
  lastCleanupAt: number | null;
}

/** Minimum Redis surface the data layer needs. */
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

/**
 * BullMQ's `RedisClient` is `Redis | Cluster` and hides scan/del on its public
 * type. Intersect with `RedisCommands` to surface them; `interface extends`
 * doesn't work here because TS doesn't allow extending a union.
 */
type FullRedisClient = RedisClient & RedisCommands;

export interface CreateContextOptions {
  /** Override the default SQLite path (used by tests). */
  dbPath?: string;
}

function createRedisClient(config: Config): ContextRedisClient {
  let connection: RedisConnection | null = null;
  let clientPromise: Promise<FullRedisClient> | null = null;

  const getClient = (): Promise<FullRedisClient> => {
    if (!clientPromise) {
      connection = new RedisConnection(
        {
          ...redisConnectionOptions(config),
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
      clientPromise = (connection.client as Promise<FullRedisClient>).catch((err) => {
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
      const client = await getClient();
      return client.scan(cursor, ...args);
    },
    async del(...keys: string[]): Promise<number> {
      const client = await getClient();
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
    queueNamesCache: null,
    queueStore: { lastCleanupAt: null },
  };
}

/**
 * Tear down every connection owned by a Context: BullMQ queues, the Redis
 * client, and the SQLite handle. The Redis quit is best-effort (its `.catch`
 * is internal); the other two propagate failures so callers can decide
 * whether to surface or swallow them.
 */
export async function closeContext(ctx: Context): Promise<void> {
  await closeAllQueues(ctx);
  await ctx.redis.quit().catch(() => {});
  ctx.db.close();
}
