import { describe, expect, it } from "bun:test";
import { formatJobsRetry } from "./formatters.js";
import { computeRetryExitCode } from "./json-reporter.js";
import type { JobsRetryOutput } from "./json-reporter.js";

function baseOutput(overrides: Partial<JobsRetryOutput> = {}): JobsRetryOutput {
  return {
    timestamp: "2026-04-21T00:00:00.000Z",
    command: "jobs-retry",
    dryRun: false,
    queue: "payments",
    filter: { jobState: "failed" },
    matched: 0,
    retried: 0,
    errors: [],
    sampleJobIds: [],
    totalFailed: 0,
    truncated: false,
    ...overrides,
  };
}

describe("formatJobsRetry — dry-run output", () => {
  it("renders DRY RUN header and 'Run without --dry-run' footer", () => {
    const out = formatJobsRetry(
      baseOutput({
        dryRun: true,
        matched: 3,
        sampleJobIds: ["a", "b", "c"],
        totalFailed: 3,
      }),
    );
    expect(out).toContain("DRY RUN: would retry 3 jobs in queue 'payments'");
    expect(out).toContain("Run without --dry-run to retry these jobs.");
    expect(out).toContain("Sample matched IDs:");
    expect(out).toContain("  a");
  });

  it("renders filter summary including since and name when present", () => {
    const out = formatJobsRetry(
      baseOutput({
        dryRun: true,
        filter: { jobState: "failed", since: "1h", name: "welcome" },
      }),
    );
    expect(out).toContain("state=failed, since=1h, name=welcome");
  });

  it("omits Retried/Errors counts on dry-run", () => {
    const out = formatJobsRetry(baseOutput({ dryRun: true, matched: 2 }));
    expect(out).not.toContain("Retried:");
    expect(out).not.toContain("Errors:       ");
  });
});

describe("formatJobsRetry — live output", () => {
  it("renders 'Retry complete' header and counts", () => {
    const out = formatJobsRetry(
      baseOutput({
        matched: 5,
        retried: 5,
        totalFailed: 5,
        sampleJobIds: ["a", "b"],
      }),
    );
    expect(out).toContain("Retry complete for queue 'payments'");
    expect(out).toContain("Retried:      5");
    expect(out).toContain("Errors:       0");
    expect(out).not.toContain("Run without --dry-run");
  });

  it("renders errors table with up to MAX_DISPLAYED_ERRORS rows", () => {
    const manyErrors = Array.from({ length: 15 }, (_, i) => ({
      jobId: `j${i}`,
      error: `fail ${i}`,
    }));
    const out = formatJobsRetry(
      baseOutput({
        matched: 15,
        retried: 0,
        errors: manyErrors,
        totalFailed: 15,
      }),
    );
    // Table contains the first 10 job IDs
    for (let i = 0; i < 10; i += 1) {
      expect(out).toContain(`j${i}`);
    }
    // The 11th and later are truncated out of the table
    expect(out).not.toContain("j14 ");
    // Overflow line shows the remaining count
    expect(out).toContain("... and 5 more");
  });

  it("omits the overflow line when errors.length <= MAX_DISPLAYED_ERRORS", () => {
    const out = formatJobsRetry(
      baseOutput({
        matched: 3,
        retried: 1,
        errors: [
          { jobId: "x", error: "nope" },
          { jobId: "y", error: "nope" },
        ],
        totalFailed: 3,
      }),
    );
    expect(out).toContain("Errors:");
    expect(out).not.toContain("... and");
  });
});

describe("formatJobsRetry — edge cases", () => {
  it("appends truncation note when truncated is true", () => {
    const out = formatJobsRetry(baseOutput({ truncated: true, totalFailed: 50000 }));
    expect(out).toContain("more failed jobs exist than were fetched");
  });

  it("omits Sample section when sampleJobIds is empty", () => {
    const out = formatJobsRetry(baseOutput({ dryRun: true, matched: 0 }));
    expect(out).not.toContain("Sample matched IDs:");
  });
});

describe("computeRetryExitCode", () => {
  it("returns 0 on dry-run regardless of errors or matches", () => {
    expect(computeRetryExitCode(baseOutput({ dryRun: true }))).toBe(0);
    expect(computeRetryExitCode(baseOutput({ dryRun: true, matched: 100 }))).toBe(0);
    // Errors shouldn't be set on dry-run, but guard against mistaken input:
    expect(
      computeRetryExitCode(baseOutput({ dryRun: true, errors: [{ jobId: "a", error: "x" }] })),
    ).toBe(0);
  });

  it("returns 0 on live with no errors", () => {
    expect(computeRetryExitCode(baseOutput({ matched: 5, retried: 5 }))).toBe(0);
  });

  it("returns 0 on live with zero matches (empty match is success, not failure)", () => {
    expect(computeRetryExitCode(baseOutput({ matched: 0, retried: 0 }))).toBe(0);
  });

  it("returns 3 on live when any error is recorded", () => {
    expect(
      computeRetryExitCode(
        baseOutput({
          matched: 5,
          retried: 4,
          errors: [{ jobId: "b", error: "job not found" }],
        }),
      ),
    ).toBe(3);
  });
});
