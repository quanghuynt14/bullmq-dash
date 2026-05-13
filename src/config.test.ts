import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config.js";

describe("loadConfig — soft-delete retention", () => {
  it("defaults retentionMs to 7 days when nothing overrides it", () => {
    const cfg = loadConfig({}, null);
    expect(cfg.retentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("accepts a profile-supplied retentionMs override", () => {
    const cfg = loadConfig(
      {},
      {
        sourcePath: "/test/config.json",
        name: "test",
        profile: { retentionMs: 60_000 },
      },
    );
    expect(cfg.retentionMs).toBe(60_000);
  });
});
