import { describe, expect, it } from "bun:test";
import { omitObservationMetadata, publicJobSummary } from "./json-reporter.js";

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
