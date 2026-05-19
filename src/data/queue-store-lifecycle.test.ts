import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, type Context } from "../context.js";
import type { Config } from "../config.js";
import { runQueueStoreCleanupIfDue } from "./queue-store-lifecycle.js";

const baseConfig: Config = {
  redis: { host: "localhost", port: 6379, db: 0, tls: false },
  pollInterval: 5000,
  prefix: "bull",
  queueNames: undefined,
  cacheTtlMs: 24 * 60 * 60 * 1000,
};

let ctx: Context | null = null;
let tmpDir: string | null = null;

afterEach(() => {
  if (ctx) {
    try {
      ctx.db.close();
    } catch {
      // Some tests intentionally close the handle before cleanup.
    }
    ctx = null;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function createTestContext(): Context {
  tmpDir = mkdtempSync(join(tmpdir(), "bullmq-dash-lifecycle-"));
  ctx = createContext(baseConfig, { dbPath: join(tmpDir, "cache.db") });
  return ctx;
}

describe("runQueueStoreCleanupIfDue", () => {
  it("rate-limits cleanup attempts even when expiration fails", () => {
    const testCtx = createTestContext();
    testCtx.db.close();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    runQueueStoreCleanupIfDue(testCtx, 1000);
    runQueueStoreCleanupIfDue(testCtx, 2000);

    expect(testCtx.queueStore.lastCleanupAt).toBe(1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
