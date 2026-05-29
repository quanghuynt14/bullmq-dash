import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config.js";

describe("loadConfig — cache TTL", () => {
  it("defaults cacheTtlMs to 24 hours when nothing overrides it", () => {
    const cfg = loadConfig({}, null);
    expect(cfg.cacheTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it("accepts a profile-supplied cacheTtlMs override", () => {
    const cfg = loadConfig(
      {},
      {
        sourcePath: "/test/config.json",
        name: "test",
        profile: { cacheTtlMs: 60_000 },
      },
    );
    expect(cfg.cacheTtlMs).toBe(60_000);
  });
});
