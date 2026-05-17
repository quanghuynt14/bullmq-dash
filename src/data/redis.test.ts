import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { setConfig } from "../config.js";
import type { Config } from "../config.js";

interface FakeClient {
  ping: () => Promise<string>;
}

interface PendingConnection {
  options: Record<string, unknown>;
  extraOptions: Record<string, unknown> | undefined;
  resolveClient: (client: FakeClient) => void;
  rejectClient: (err: unknown) => void;
  close: () => Promise<void>;
}

const state: {
  constructions: PendingConnection[];
  closeCount: number;
} = {
  constructions: [],
  closeCount: 0,
};

mock.module("bullmq", () => ({
  RedisConnection: class {
    public readonly client: Promise<FakeClient>;
    constructor(options: Record<string, unknown>, extraOptions?: Record<string, unknown>) {
      let resolveClient!: (client: FakeClient) => void;
      let rejectClient!: (err: unknown) => void;
      this.client = new Promise<FakeClient>((resolve, reject) => {
        resolveClient = resolve;
        rejectClient = reject;
      });
      state.constructions.push({
        options,
        extraOptions,
        resolveClient,
        rejectClient,
        close: async () => {
          state.closeCount += 1;
        },
      });
    }
    async close(): Promise<void> {
      state.closeCount += 1;
    }
  },
}));

// Import after the mock so getRedisClient uses the stubbed RedisConnection.
const { getRedisClient, disconnectRedis, pingRedis } = await import("./redis.js");

const testConfig: Config = {
  redis: {
    host: "localhost",
    port: 6379,
    db: 0,
  },
  pollInterval: 5000,
  prefix: "bull",
  retentionMs: 86_400_000,
};

beforeEach(async () => {
  setConfig(testConfig);
  state.constructions = [];
  state.closeCount = 0;
  // Ensure cross-test isolation: redis.ts holds module-level singletons.
  await disconnectRedis();
});

afterEach(async () => {
  // Drain any unresolved promise so the next test starts clean.
  for (const pending of state.constructions) {
    pending.rejectClient(new Error("test cleanup"));
  }
  await disconnectRedis().catch(() => {});
});

describe("getRedisClient", () => {
  it("memoizes the connection — concurrent calls share one RedisConnection", async () => {
    const p1 = getRedisClient();
    const p2 = getRedisClient();

    expect(state.constructions.length).toBe(1);
    state.constructions[0]!.resolveClient({ ping: async () => "PONG" });

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(c2);
  });

  it("clears the cache when the bootstrap promise rejects so the next call can retry", async () => {
    const firstAttempt = getRedisClient().catch((err: Error) => err);
    expect(state.constructions.length).toBe(1);

    state.constructions[0]!.rejectClient(new Error("boom"));
    const err = await firstAttempt;
    expect((err as Error).message).toBe("boom");

    // Yield once so the `.catch` handler runs and clears the cache.
    await Promise.resolve();

    const secondAttempt = getRedisClient();
    expect(state.constructions.length).toBe(2);
    state.constructions[1]!.resolveClient({ ping: async () => "PONG" });
    await expect(secondAttempt).resolves.toBeDefined();
  });

  it("constructs a fresh connection after disconnectRedis", async () => {
    const first = getRedisClient();
    state.constructions[0]!.resolveClient({ ping: async () => "PONG" });
    await first;
    expect(state.constructions.length).toBe(1);

    await disconnectRedis();
    expect(state.closeCount).toBe(1);

    const second = getRedisClient();
    expect(state.constructions.length).toBe(2);
    state.constructions[1]!.resolveClient({ ping: async () => "PONG" });
    await second;
  });

  it("passes redis config and lazyConnect to RedisConnection, with a bounded retryStrategy", async () => {
    const attempt = getRedisClient();
    state.constructions[0]!.resolveClient({ ping: async () => "PONG" });
    await attempt;

    const options = state.constructions[0]!.options;
    expect(options.host).toBe("localhost");
    expect(options.port).toBe(6379);
    expect(options.lazyConnect).toBe(true);
    const retry = options.retryStrategy as (times: number) => number | null;
    // Backoff is times*200 capped at 2000, with null after attempt 3.
    // retry(0) is the first attempt — ioredis passes 0 on the initial
    // connect — so a 0ms delay is correct. retry(1..3) is bounded
    // arithmetic. retry(20) and any far-out value must return null;
    // the >3 short-circuit is what stops ioredis from looping forever
    // against a Redis instance that's down.
    expect(retry(0)).toBe(0);
    expect(retry(1)).toBe(200);
    expect(retry(2)).toBe(400);
    expect(retry(3)).toBe(600);
    expect(retry(4)).toBe(null);
    expect(retry(20)).toBe(null);
    expect(retry(Number.MAX_SAFE_INTEGER)).toBe(null);
  });

  it("opts out of BullMQ's blocking-mode default so maxRetriesPerRequest stays intact", async () => {
    // Regression guard: BullMQ's RedisConnection defaults extraOptions to
    // { blocking: true }, which unconditionally sets maxRetriesPerRequest = null
    // on the underlying ioredis client. That is the right default for queue
    // workers but the wrong default for a read-only dashboard — a stalled
    // command would loop indefinitely instead of failing fast. We pass
    // { blocking: false } explicitly; if a future refactor drops it, this
    // test fails before any user notices a hang.
    const attempt = getRedisClient();
    state.constructions[0]!.resolveClient({ ping: async () => "PONG" });
    await attempt;

    expect(state.constructions[0]!.extraOptions).toEqual({ blocking: false });
  });

  it("shares the rejected promise across concurrent callers, then retries from a clean slate", async () => {
    // The behaviour under test is the cache-clear in redis.ts's .catch
    // handler: after a rejection, the next call must construct a fresh
    // RedisConnection rather than re-await the rejected promise. The
    // first half (p1/p2 sharing the same rejection) only proves that
    // both callers await the same in-flight promise; the third call
    // below is the real assertion that the rejection isn't sticky.
    const p1 = getRedisClient().catch((err: Error) => err);
    const p2 = getRedisClient().catch((err: Error) => err);
    expect(state.constructions.length).toBe(1);

    state.constructions[0]!.rejectClient(new Error("boom"));
    const [err1, err2] = await Promise.all([p1, p2]);
    expect((err1 as Error).message).toBe("boom");
    expect((err2 as Error).message).toBe("boom");

    // After the catch handler clears the cache, a third call gets a
    // fresh construction — this is what proves the cache-clear works.
    await Promise.resolve();
    const p3 = getRedisClient();
    expect(state.constructions.length).toBe(2);
    state.constructions[1]!.resolveClient({ ping: async () => "PONG" });
    await expect(p3).resolves.toBeDefined();
  });
});

describe("pingRedis", () => {
  it("returns true when the client responds PONG", async () => {
    const ping = pingRedis();
    state.constructions[0]!.resolveClient({ ping: async () => "PONG" });
    expect(await ping).toBe(true);
  });

  it("returns false when the client throws, and a subsequent ping can recover", async () => {
    const firstPing = pingRedis();
    state.constructions[0]!.rejectClient(new Error("connection refused"));
    expect(await firstPing).toBe(false);

    await Promise.resolve();

    const secondPing = pingRedis();
    expect(state.constructions.length).toBe(2);
    state.constructions[1]!.resolveClient({ ping: async () => "PONG" });
    expect(await secondPing).toBe(true);
  });
});
