import { describe, expect, it, spyOn } from "bun:test";
import { omitObservationMetadata, publicJobSummary, runJsonMode } from "./json-reporter.js";
import type { Context } from "./context.js";

describe("omitObservationMetadata", () => {
  it("removes cache observation metadata from public JSON records", () => {
    const record = {
      id: "42",
      name: "send-email",
      state: "completed",
      timestamp: 1000,
      lastObservedAt: 2000,
    };

    expect(omitObservationMetadata(record)).toEqual({
      id: "42",
      name: "send-email",
      state: "completed",
      timestamp: 1000,
    });
    expect(record.lastObservedAt).toBe(2000);
  });
});

describe("publicJobSummary", () => {
  it("keeps jobs list output on the documented public schema", () => {
    const job = {
      id: "42",
      name: "send-email",
      state: "completed",
      timestamp: 1000,
      data: { token: "secret" },
      lastObservedAt: 2000,
    };

    expect(publicJobSummary(job)).toEqual({
      id: "42",
      name: "send-email",
      state: "completed",
      timestamp: 1000,
    });
  });
});

describe("runJsonMode destructive confirmation", () => {
  it("requires --yes before a live jobs retry in non-interactive mode", async () => {
    let connected = false;
    const ctx = {
      redis: {
        connect: async () => {
          connected = true;
        },
      },
    } as unknown as Context;
    const subcommand = {
      kind: "jobs-retry" as const,
      queue: "payments",
      jobState: "failed",
      jobId: "42",
      dryRun: false,
    };

    const originalIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expect(runJsonMode(ctx, subcommand, false, false)).rejects.toThrow("process.exit(2)");
      expect(connected).toBe(false);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      if (originalIsTty) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTty);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  });
});
