import { RedisConnection, type RedisClient } from "bullmq";
import { getConfig } from "../config.js";

let redisConnection: RedisConnection | null = null;
let redisClientPromise: Promise<RedisClient> | null = null;

export async function getRedisClient(): Promise<RedisClient> {
  if (!redisClientPromise) {
    const config = getConfig();
    redisConnection = new RedisConnection({
      host: config.redis.host,
      port: config.redis.port,
      username: config.redis.username,
      password: config.redis.password,
      db: config.redis.db,
      ...(config.redis.tls ? { tls: {} } : {}),
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 3) {
          return null; // Stop retrying after 3 attempts
        }
        return Math.min(times * 200, 2000);
      },
    });
    // Clear the cache on rejection so a transient bootstrap failure
    // (bad URL, version-check error, etc.) doesn't pin the cached
    // promise to the rejected state for the rest of the process — the
    // next getRedisClient() call will retry from a clean slate.
    redisClientPromise = redisConnection.client.catch((err) => {
      redisClientPromise = null;
      redisConnection = null;
      throw err;
    });
  }
  return redisClientPromise;
}

export async function connectRedis(): Promise<void> {
  await getRedisClient();
}

export async function disconnectRedis(): Promise<void> {
  if (redisConnection) {
    await redisConnection.close();
    redisConnection = null;
    redisClientPromise = null;
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    const client = await getRedisClient();
    const result = await client.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
