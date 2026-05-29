import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Config } from "./config.js";
import type { Context } from "./context.js";

interface FakeClient {
  scan: () => Promise<[string, string[]]>;
  del: () => Promise<number>;
}

interface PendingConnection {
  options: Record<string, unknown>;
  extraOptions: Record<string, unknown> | undefined;
  resolveClient: (client: FakeClient) => void;
  rejectClient: (err: unknown) => void;
}

const state: {
  constructions: PendingConnection[];
  closeCount: number;
} = {
  constructions: [],
  closeCount: 0,
};

mock.module("bullmq", () => ({
  Queue: class {
    async close(): Promise<void> {}
  },
  RedisConnection: class {
    public readonly client: Promise<FakeClient>;
    public status = "wait";

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
      });
    }

    on(): void {}

    async close(): Promise<void> {
      state.closeCount += 1;
    }
  },
}));

const { createContext, closeContext } = await import("./context.js");

const TEST_DB_PATH = `${import.meta.dirname}/test-context-redis.db`;

const testConfig: Config = {
  redis: {
    host: "localhost",
    port: 6379,
    db: 0,
  },
  pollInterval: 5000,
  prefix: "bull",
  cacheTtlMs: 86_400_000,
};

function fakeClient(): FakeClient {
  return {
    scan: async () => ["0", []],
    del: async () => 0,
  };
}

let active: Context | null = null;

beforeEach(() => {
  state.constructions = [];
  state.closeCount = 0;
});

afterEach(async () => {
  for (const pending of state.constructions) {
    pending.rejectClient(new Error("test cleanup"));
  }
  if (active) {
    await closeContext(active).catch(() => {});
    active = null;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // ignore
    }
  }
});

describe("Context Redis client", () => {
  it("memoizes the connection within one Context while keeping construction lazy", async () => {
    active = createContext(testConfig, { dbPath: TEST_DB_PATH });

    expect(state.constructions.length).toBe(0);

    const p1 = active.redis.connect();
    const p2 = active.redis.scan("0");

    expect(state.constructions.length).toBe(1);
    state.constructions[0]!.resolveClient(fakeClient());

    await Promise.all([p1, p2]);
  });

  it("clears the cache when the bootstrap promise rejects so the next call can retry", async () => {
    active = createContext(testConfig, { dbPath: TEST_DB_PATH });

    const firstAttempt = active.redis.connect().catch((err: Error) => err);
    expect(state.constructions.length).toBe(1);

    state.constructions[0]!.rejectClient(new Error("boom"));
    const err = await firstAttempt;
    expect((err as Error).message).toBe("boom");

    await Promise.resolve();

    const secondAttempt = active.redis.connect();
    expect(state.constructions.length).toBe(2);
    state.constructions[1]!.resolveClient(fakeClient());
    await expect(secondAttempt).resolves.toBeUndefined();
  });

  it("constructs a fresh connection after quit", async () => {
    active = createContext(testConfig, { dbPath: TEST_DB_PATH });

    const first = active.redis.connect();
    state.constructions[0]!.resolveClient(fakeClient());
    await first;
    expect(state.constructions.length).toBe(1);

    await active.redis.quit();
    expect(state.closeCount).toBe(1);

    const second = active.redis.connect();
    expect(state.constructions.length).toBe(2);
    state.constructions[1]!.resolveClient(fakeClient());
    await second;
  });

  it("passes redis config and lazyConnect to RedisConnection, with a bounded retryStrategy", async () => {
    active = createContext(testConfig, { dbPath: TEST_DB_PATH });

    const attempt = active.redis.connect();
    state.constructions[0]!.resolveClient(fakeClient());
    await attempt;

    const options = state.constructions[0]!.options;
    expect(options.host).toBe("localhost");
    expect(options.port).toBe(6379);
    expect(options.lazyConnect).toBe(true);
    const retry = options.retryStrategy as (times: number) => number | null;
    expect(retry(0)).toBe(0);
    expect(retry(1)).toBe(200);
    expect(retry(2)).toBe(400);
    expect(retry(3)).toBe(600);
    expect(retry(4)).toBe(null);
    expect(retry(20)).toBe(null);
    expect(retry(Number.MAX_SAFE_INTEGER)).toBe(null);
  });

  it("opts out of BullMQ's blocking-mode default so command retry budgets stay intact", async () => {
    active = createContext(testConfig, { dbPath: TEST_DB_PATH });

    const attempt = active.redis.connect();
    state.constructions[0]!.resolveClient(fakeClient());
    await attempt;

    expect(state.constructions[0]!.extraOptions).toEqual({ blocking: false });
  });
});
