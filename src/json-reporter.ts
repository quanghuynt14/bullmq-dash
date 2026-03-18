import { connectRedis, disconnectRedis } from "./data/redis.js";
import { discoverQueueNames, getQueueStats, closeAllQueues } from "./data/queues.js";
import { writeError } from "./errors.js";
import type { Config } from "./config.js";
import { setConfig } from "./config.js";

async function fetchSnapshot() {
  const queueNames = await discoverQueueNames();
  const queues = await Promise.all(queueNames.map((name) => getQueueStats(name)));

  // Aggregate job counts across all queues
  const jobCounts = queues.reduce(
    (acc, q) => ({
      wait: acc.wait + q.counts.wait,
      active: acc.active + q.counts.active,
      completed: acc.completed + q.counts.completed,
      failed: acc.failed + q.counts.failed,
      delayed: acc.delayed + q.counts.delayed,
      total: acc.total + q.total,
    }),
    { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 },
  );

  return {
    timestamp: new Date().toISOString(),
    queues,
    metrics: {
      queueCount: queues.length,
      jobCounts,
    },
  };
}

export async function runJsonSnapshot(config: Config): Promise<void> {
  setConfig(config);

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
    const snapshot = await fetchSnapshot();
    process.stdout.write(JSON.stringify(snapshot) + "\n");
  } catch (error) {
    writeError(
      "Failed to fetch snapshot",
      "RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    await closeAllQueues();
    await disconnectRedis();
    process.exit(1);
  }

  await closeAllQueues();
  await disconnectRedis();
  process.exit(0);
}
