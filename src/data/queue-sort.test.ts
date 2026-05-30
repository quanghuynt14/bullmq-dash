import { describe, expect, it } from "bun:test";
import { sortQueues } from "./queue-sort.js";
import type { QueueStats } from "./queues.js";

function queue(name: string, counts: Partial<QueueStats["counts"]> = {}): QueueStats {
  const normalizedCounts = {
    wait: counts.wait ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    schedulers: counts.schedulers ?? 0,
  };

  return {
    name,
    counts: normalizedCounts,
    isPaused: false,
    total:
      normalizedCounts.wait +
      normalizedCounts.active +
      normalizedCounts.completed +
      normalizedCounts.failed +
      normalizedCounts.delayed,
  };
}

describe("sortQueues", () => {
  it("sorts by task size with the largest queues first", () => {
    const queues = [
      queue("small", { wait: 1 }),
      queue("large", { wait: 10, failed: 2 }),
      queue("medium", { active: 4 }),
    ];

    expect(sortQueues(queues, "task-size", "desc").map((q) => q.name)).toEqual([
      "large",
      "medium",
      "small",
    ]);
  });

  it("uses queue name as a stable tie breaker for metric sorts", () => {
    const queues = [
      queue("zeta", { failed: 1 }),
      queue("alpha", { failed: 1 }),
      queue("beta", { failed: 2 }),
    ];

    expect(sortQueues(queues, "failed", "desc").map((q) => q.name)).toEqual([
      "beta",
      "alpha",
      "zeta",
    ]);
  });
});
