import type { RedisOptions } from "bullmq";
import type { Config } from "./config.js";

export function redisConnectionOptions(config: Config): RedisOptions {
  return {
    host: config.redis.host,
    port: config.redis.port,
    username: config.redis.username,
    password: config.redis.password,
    db: config.redis.db,
    ...(config.redis.tls ? { tls: {} } : {}),
  };
}
