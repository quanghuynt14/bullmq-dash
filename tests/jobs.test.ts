import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { formatRelativeTime, formatTimestamp } from "../src/data/jobs.js";

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
