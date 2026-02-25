import { connectRedis, disconnectRedis } from "./data/redis.js";
import { discoverQueueNames, getQueueStats, closeAllQueues } from "./data/queues.js";
import { getGlobalMetrics } from "./data/metrics.js";
import { writeError } from "./errors.js";
import type { Config } from "./config.js";
import { setConfig } from "./config.js";

async function fetchSnapshot(config: Config) {
  setConfig(config);
  const queueNames = await discoverQueueNames();
  const queues = await Promise.all(queueNames.map((name) => getQueueStats(name)));
  const metrics = await getGlobalMetrics();

  return {
    timestamp: new Date().toISOString(),
    queues,
    metrics,
  };
}

export async function runJsonSnapshot(config: Config): Promise<void> {
  try {
    await connectRedis();
  } catch (error) {
    writeError(
      "Redis connection failed",
      "REDIS_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(3);
  }

  try {
    const snapshot = await fetchSnapshot(config);
    process.stdout.write(JSON.stringify(snapshot) + "\n");
  } finally {
    await closeAllQueues();
    await disconnectRedis();
  }

  process.exit(0);
}

export async function runJsonWatch(config: Config): Promise<void> {
  try {
    await connectRedis();
  } catch (error) {
    writeError(
      "Redis connection failed",
      "REDIS_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(3);
  }

  process.on("SIGINT", async () => {
    await closeAllQueues();
    await disconnectRedis();
    process.exit(0);
  });

  while (true) {
    try {
      const snapshot = await fetchSnapshot(config);
      process.stdout.write(JSON.stringify(snapshot) + "\n");
    } catch (error) {
      writeError(
        "Failed to fetch snapshot",
        "RUNTIME_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollInterval));
  }
}
