import { Database } from "bun:sqlite";
import { RedisConnection, type Queue, type RedisClient } from "bullmq";
import type { Config } from "./config.js";
import { createSqliteDb } from "./data/sqlite.js";

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
  /** Per-context sync lock — see sync.ts. */
  readonly syncLock: SyncLockState;
  /** `${queue}:${id}` → Date.now() of polling's last write. See sync.ts. */
  readonly recentlyPolledWrites: Map<string, number>;
}

export interface SyncLockState {
  inProgress: boolean;
  acquiredAt: number | null;
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
    syncLock: { inProgress: false, acquiredAt: null },
    recentlyPolledWrites: new Map(),
  };
}
