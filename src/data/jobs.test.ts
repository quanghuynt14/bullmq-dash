import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { setConfig } from "../config.js";
import { formatRelativeTime, formatTimestamp, getJobsFromStore } from "./jobs.js";
import { parseDuration } from "./duration.js";
import { closeSqliteDb, createSqliteDb, upsertJobs } from "./sqlite.js";

const TEST_DB_PATH = `${import.meta.dirname}/test-jobs.db`;

describe("getJobsFromStore", () => {
  beforeEach(() => {
    setConfig({
      redis: { host: "localhost", port: 6379, db: 0 },
      pollInterval: 3000,
      prefix: "bull",
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    createSqliteDb(TEST_DB_PATH);
  });

  afterEach(() => {
    closeSqliteDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // ignore
      }
    }
  });

  it("reads paginated jobs from the queue-data store", async () => {
    upsertJobs("email", [
      { id: "old", name: "old-job", state: "completed", timestamp: 1000 },
      { id: "new", name: "new-job", state: "active", timestamp: 2000 },
    ]);

    const result = await getJobsFromStore("email", "latest", 1, 1);

    expect(result).toEqual({
      jobs: [{ id: "new", name: "new-job", state: "active", timestamp: 2000 }],
      total: 2,
      page: 1,
      pageSize: 1,
      totalPages: 2,
    });
  });

  it("maps the wait filter to waiting and prioritized jobs", async () => {
    upsertJobs("email", [
      { id: "waiting", name: "waiting-job", state: "waiting", timestamp: 3000 },
      { id: "prioritized", name: "prioritized-job", state: "prioritized", timestamp: 2000 },
      { id: "active", name: "active-job", state: "active", timestamp: 1000 },
    ]);

    const result = await getJobsFromStore("email", "wait", 1, 25);

    expect(result.jobs.map((job) => job.id)).toEqual(["waiting", "prioritized"]);
    expect(result.total).toBe(2);
  });

  it("returns jobs from all states ordered by timestamp under the latest filter", async () => {
    upsertJobs("email", [
      { id: "wait-old", name: "w", state: "waiting", timestamp: 1000 },
      { id: "done-mid", name: "c", state: "completed", timestamp: 2000 },
      { id: "fail-new", name: "f", state: "failed", timestamp: 3000 },
      { id: "act-newest", name: "a", state: "active", timestamp: 4000 },
    ]);

    const result = await getJobsFromStore("email", "latest", 1, 25);

    expect(result.jobs.map((job) => job.id)).toEqual([
      "act-newest",
      "fail-new",
      "done-mid",
      "wait-old",
    ]);
    expect(result.total).toBe(4);
  });

  it("rejects scheduler reads through the jobs store path", async () => {
    await expect(getJobsFromStore("email", "schedulers", 1, 25)).rejects.toThrow(
      /Cannot fetch schedulers/,
    );
  });
});

describe("formatRelativeTime", () => {
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("returns 'just now' for current timestamp", () => {
    const now = 1700000000000;
    Date.now = () => now;
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns seconds ago for recent timestamps", () => {
    const now = 1700000000000;
    Date.now = () => now;

    expect(formatRelativeTime(now - 1000)).toBe("1s ago"); // 1 second
    expect(formatRelativeTime(now - 30000)).toBe("30s ago"); // 30 seconds
    expect(formatRelativeTime(now - 59000)).toBe("59s ago"); // 59 seconds
  });

  it("returns minutes ago for timestamps within an hour", () => {
    const now = 1700000000000;
    Date.now = () => now;

    expect(formatRelativeTime(now - 60000)).toBe("1m ago"); // 1 minute
    expect(formatRelativeTime(now - 300000)).toBe("5m ago"); // 5 minutes
    expect(formatRelativeTime(now - 3540000)).toBe("59m ago"); // 59 minutes
  });

  it("returns hours ago for timestamps within a day", () => {
    const now = 1700000000000;
    Date.now = () => now;

    expect(formatRelativeTime(now - 3600000)).toBe("1h ago"); // 1 hour
    expect(formatRelativeTime(now - 7200000)).toBe("2h ago"); // 2 hours
    expect(formatRelativeTime(now - 82800000)).toBe("23h ago"); // 23 hours
  });

  it("returns days ago for timestamps older than a day", () => {
    const now = 1700000000000;
    Date.now = () => now;

    expect(formatRelativeTime(now - 86400000)).toBe("1d ago"); // 1 day
    expect(formatRelativeTime(now - 172800000)).toBe("2d ago"); // 2 days
    expect(formatRelativeTime(now - 604800000)).toBe("7d ago"); // 7 days
    expect(formatRelativeTime(now - 2592000000)).toBe("30d ago"); // 30 days
  });

  it("handles edge case at boundary values", () => {
    const now = 1700000000000;
    Date.now = () => now;

    // Exactly 60 seconds - should show 1m
    expect(formatRelativeTime(now - 60000)).toBe("1m ago");

    // Exactly 60 minutes - should show 1h
    expect(formatRelativeTime(now - 3600000)).toBe("1h ago");

    // Exactly 24 hours - should show 1d
    expect(formatRelativeTime(now - 86400000)).toBe("1d ago");
  });

  it("handles timestamp of 0", () => {
    const now = 1700000000000;
    Date.now = () => now;
    // Very old timestamp - should be many days
    const result = formatRelativeTime(0);
    expect(result).toMatch(/\d+d ago/);
  });
});

describe("formatTimestamp", () => {
  it("returns 'N/A' for undefined", () => {
    expect(formatTimestamp(undefined)).toBe("N/A");
  });

  it("returns 'N/A' for 0", () => {
    expect(formatTimestamp(0)).toBe("N/A");
  });

  it("formats timestamp to ISO-like string", () => {
    // Use a known timestamp: 2023-11-15T10:30:45.000Z
    const timestamp = 1700044245000;
    const result = formatTimestamp(timestamp);

    // Should be in format "YYYY-MM-DD HH:MM:SS"
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("removes milliseconds and T separator", () => {
    const timestamp = 1700044245123; // Has milliseconds
    const result = formatTimestamp(timestamp);

    // Should not contain T or milliseconds
    expect(result).not.toContain("T");
    expect(result).not.toContain(".");
    expect(result).not.toContain("Z");
  });

  it("returns consistent format for various timestamps", () => {
    const timestamps = [
      1609459200000, // 2021-01-01 00:00:00
      1625140800000, // 2021-07-01 12:00:00
      1700000000000, // 2023-11-14
    ];

    for (const ts of timestamps) {
      const result = formatTimestamp(ts);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(result.length).toBe(19); // "YYYY-MM-DD HH:MM:SS" = 19 chars
    }
  });
});

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30 * 1000);
    expect(parseDuration("1s")).toBe(1000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(5 * 60 * 1000);
    expect(parseDuration("1m")).toBe(60 * 1000);
  });

  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(60 * 60 * 1000);
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns null for invalid format", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("1")).toBeNull();
    expect(parseDuration("s")).toBeNull();
    expect(parseDuration("1.5h")).toBeNull();
    expect(parseDuration("-1h")).toBeNull();
    expect(parseDuration("1y")).toBeNull(); // unsupported unit
    expect(parseDuration(" 1h")).toBeNull(); // leading space
    expect(parseDuration("1h ")).toBeNull(); // trailing space
    expect(parseDuration("1 h")).toBeNull(); // space inside
  });

  it("returns null for zero", () => {
    // Zero durations don't make sense as a filter — should fail explicitly
    expect(parseDuration("0s")).toBeNull();
    expect(parseDuration("0h")).toBeNull();
  });
});
