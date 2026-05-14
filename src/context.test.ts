import { afterEach, describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Config } from "./config.js";
import { createContext, type Context } from "./context.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-context.db`;

const baseConfig: Config = {
  redis: { host: "localhost", port: 6379, db: 0 },
  pollInterval: 3000,
  prefix: "bull",
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};

let active: Context | null = null;

afterEach(async () => {
  if (active) {
    active.db.close();
    await active.redis.quit().catch(() => {});
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

describe("createContext", () => {
  it("returns a Context whose config matches input", () => {
    active = createContext(baseConfig, { dbPath: TEST_DB_PATH });

    expect(active.config).toEqual(baseConfig);
  });

  it("provides a working SQLite handle with the bullmq-dash schema initialized", () => {
    active = createContext(baseConfig, { dbPath: TEST_DB_PATH });

    // Writing through the schema and reading it back proves the handle is
    // real and the migrations/schema have run.
    active.db
      .prepare("INSERT INTO jobs (id, queue, name, state, timestamp) VALUES (?, ?, ?, ?, ?)")
      .run("1", "q", "job", "waiting", 1000);

    const row = active.db.prepare("SELECT id, queue, state FROM jobs WHERE id = ?").get("1");
    expect(row).toEqual({ id: "1", queue: "q", state: "waiting" });
  });

  it("provides a lazy-connect Redis client (does not open a TCP connection eagerly)", () => {
    active = createContext(baseConfig, { dbPath: TEST_DB_PATH });

    // ioredis exposes `.status`; a lazy-connect client sits in 'wait' until
    // someone calls .connect() or issues a command. We want lazy connection
    // so building a Context in tests or short-lived CLI calls doesn't open
    // a socket that's never used.
    expect(active.redis.status).toBe("wait");
  });

  it("provides an empty queue cache that callers can populate", () => {
    active = createContext(baseConfig, { dbPath: TEST_DB_PATH });

    expect(active.queueCache).toBeInstanceOf(Map);
    expect(active.queueCache.size).toBe(0);
  });

  it("builds independent contexts so two contexts share no SQLite or Redis state", async () => {
    const a = createContext(baseConfig, { dbPath: TEST_DB_PATH });
    const otherPath = `${import.meta.dirname}/test-context-other.db`;
    const b = createContext(baseConfig, { dbPath: otherPath });
    try {
      a.db
        .prepare("INSERT INTO jobs (id, queue, name, state, timestamp) VALUES (?, ?, ?, ?, ?)")
        .run("only-in-a", "q", "job", "waiting", 1);

      const seenFromB = b.db
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .get("only-in-a");

      expect(seenFromB).toBeNull();
      expect(a.redis).not.toBe(b.redis);
      expect(a.queueCache).not.toBe(b.queueCache);
    } finally {
      a.db.close();
      b.db.close();
      await Promise.allSettled([a.redis.quit(), b.redis.quit()]);
      for (const path of [TEST_DB_PATH, otherPath]) {
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            unlinkSync(path + suffix);
          } catch {
            // ignore
          }
        }
      }
    }
  });
});
