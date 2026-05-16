import { describe, expect, it } from "bun:test";
import {
  ACCEPTED_ALERT_TYPES,
  buildScoreGateSummary,
  getPackageSpec,
  isUnavailablePackageScoreError,
  renderScoreGateSummary,
} from "./socket-score.js";
import type { SocketScore } from "./audit-socket-target.js";

// Pins the allowlist so a future PR can't silently broaden it. If you're
// adding a new entry, update this list and document the justification in
// socket-score.ts beside the corresponding set.
describe("ACCEPTED_ALERT_TYPES", () => {
  it("matches the documented inherent-capability set exactly", () => {
    expect([...ACCEPTED_ALERT_TYPES].toSorted()).toEqual([
      "envVars",
      "filesystemAccess",
      "hasNativeCode",
      "minifiedFile",
      "networkAccess",
      "recentlyPublished",
      "urlStrings",
    ]);
  });
});

describe("getPackageSpec", () => {
  it("returns name@version from a valid package manifest", () => {
    expect(getPackageSpec({ name: "bullmq-dash", version: "0.3.0" })).toBe("bullmq-dash@0.3.0");
  });

  it("rejects a missing package name", () => {
    expect(() => getPackageSpec({ version: "0.3.0" })).toThrow(
      "package.json is missing a valid name",
    );
  });

  it("rejects a missing package version", () => {
    expect(() => getPackageSpec({ name: "bullmq-dash" })).toThrow(
      "package.json is missing a valid version",
    );
  });
});

describe("buildScoreGateSummary", () => {
  it("passes when every alert is in the accepted set (capabilities inherent to a Redis tool)", () => {
    const score: SocketScore = {
      ok: true,
      data: {
        purl: "pkg:npm/bullmq-dash@0.3.0",
        self: {
          alerts: [
            { severity: "middle", name: "networkAccess", example: "npm/bullmq-dash@0.3.0" },
            { severity: "middle", name: "filesystemAccess", example: "npm/bullmq-dash@0.3.0" },
            { severity: "middle", name: "recentlyPublished", example: "npm/bullmq-dash@0.3.0" },
          ],
        },
        transitively: {
          alerts: [{ severity: "middle", name: "hasNativeCode", example: "npm/bullmq@5.76.8" }],
        },
      },
    };

    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", score);

    expect(summary.clean).toBe(true);
    expect(summary.alertCount).toBe(4);
    expect(summary.acceptedAlertTypes).toEqual([
      "filesystemAccess",
      "hasNativeCode",
      "networkAccess",
      "recentlyPublished",
    ]);
    expect(summary.unexpectedAlertTypes).toEqual([]);
    expect(summary.unexpectedAlerts).toEqual([]);
  });

  it("fails when a risk-signal alert (e.g. obfuscatedFile) appears", () => {
    const score: SocketScore = {
      ok: true,
      data: {
        purl: "pkg:npm/bullmq-dash@0.3.0",
        self: {
          alerts: [{ severity: "middle", name: "networkAccess", example: "npm/bullmq-dash@0.3.0" }],
        },
        transitively: {
          alerts: [{ severity: "high", name: "obfuscatedFile", example: "npm/somepkg@1.0.0" }],
        },
      },
    };

    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", score);

    expect(summary.clean).toBe(false);
    expect(summary.acceptedAlertTypes).toEqual(["networkAccess"]);
    expect(summary.unexpectedAlertTypes).toEqual(["obfuscatedFile"]);
    expect(summary.unexpectedAlerts).toEqual(["high obfuscatedFile (npm/somepkg@1.0.0)"]);
  });

  it("fails when an unrecognized alert type appears (real regression vs the accepted set)", () => {
    const score: SocketScore = {
      ok: true,
      data: {
        purl: "pkg:npm/bullmq-dash@0.3.0",
        self: {
          alerts: [{ severity: "middle", name: "networkAccess", example: "npm/bullmq-dash@0.3.0" }],
        },
        transitively: {
          alerts: [{ severity: "high", name: "criticalCVE", example: "npm/somepkg@1.0.0" }],
        },
      },
    };

    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", score);

    expect(summary.clean).toBe(false);
    expect(summary.acceptedAlertTypes).toEqual(["networkAccess"]);
    expect(summary.unexpectedAlertTypes).toEqual(["criticalCVE"]);
    expect(summary.unexpectedAlerts).toEqual(["high criticalCVE (npm/somepkg@1.0.0)"]);
  });

  it("passes when recentlyPublished is the only alert (transient 72h window)", () => {
    // The whole point of the regression-detector framing: a fresh publish
    // legitimately trips recentlyPublished, and the gate must pass without
    // intervention. If this test ever breaks, the gate would block every
    // release for the first 72 hours after publish — not what we want.
    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", {
      ok: true,
      data: {
        purl: "pkg:npm/bullmq-dash@0.3.0",
        self: {
          alerts: [
            { severity: "low", name: "recentlyPublished", example: "npm/bullmq-dash@0.3.0" },
          ],
        },
        transitively: { alerts: [] },
      },
    });

    expect(summary.clean).toBe(true);
    expect(summary.acceptedAlertTypes).toEqual(["recentlyPublished"]);
    expect(summary.unexpectedAlertTypes).toEqual([]);
  });

  it("passes a clean score with no alerts at all", () => {
    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", {
      ok: true,
      data: {
        purl: "pkg:npm/bullmq-dash@0.3.0",
        self: { alerts: [] },
        transitively: { alerts: [] },
      },
    });

    expect(summary.clean).toBe(true);
    expect(summary.alertCount).toBe(0);
    expect(summary.alertTypes).toEqual([]);
    expect(summary.acceptedAlertTypes).toEqual([]);
    expect(summary.unexpectedAlertTypes).toEqual([]);
  });

  it("fails a zero-alert score when Socket returns a different target", () => {
    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", {
      ok: true,
      data: {
        purl: "pkg:npm/other@1.0.0",
        self: { alerts: [] },
        transitively: { alerts: [] },
      },
    });

    expect(summary.clean).toBe(false);
    expect(summary.expectedPurl).toBe("pkg:npm/bullmq-dash@0.3.0");
    expect(summary.socketPurl).toBe("pkg:npm/other@1.0.0");
  });

  it("fails a zero-alert score when Socket reports not ok", () => {
    const summary = buildScoreGateSummary("bullmq-dash@0.3.0", {
      ok: false,
      data: {
        purl: "pkg:npm/bullmq-dash@0.3.0",
        self: { alerts: [] },
        transitively: { alerts: [] },
      },
    });

    expect(summary.clean).toBe(false);
    expect(summary.socketOk).toBe(false);
  });
});

describe("renderScoreGateSummary", () => {
  it("exits nonzero when unexpected alert types appear", () => {
    const rendered = renderScoreGateSummary({
      packageSpec: "bullmq-dash@0.3.0",
      expectedPurl: "pkg:npm/bullmq-dash@0.3.0",
      socketOk: true,
      socketPurl: "pkg:npm/bullmq-dash@0.3.0",
      alertCount: 1,
      alertTypes: ["criticalCVE"],
      acceptedAlertTypes: [],
      unexpectedAlertTypes: ["criticalCVE"],
      unexpectedAlerts: ["high criticalCVE (npm/somepkg@1.0.0)"],
      clean: false,
    });

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stderr).toContain(
      "Socket reports unexpected alert types: criticalCVE. Review whether they're inherent to a new dependency (and should join the accepted list) or signal a real regression.",
    );
    expect(rendered.stderr).toContain(
      "npm/bullmq-dash@0.3.0 failed the Socket package score gate.",
    );
  });

  it("exits zero when only accepted alert types are present", () => {
    const rendered = renderScoreGateSummary({
      packageSpec: "bullmq-dash@0.3.0",
      expectedPurl: "pkg:npm/bullmq-dash@0.3.0",
      socketOk: true,
      socketPurl: "pkg:npm/bullmq-dash@0.3.0",
      alertCount: 3,
      alertTypes: ["networkAccess", "recentlyPublished", "urlStrings"],
      acceptedAlertTypes: ["networkAccess", "recentlyPublished", "urlStrings"],
      unexpectedAlertTypes: [],
      unexpectedAlerts: [],
      clean: true,
    });

    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain(
      "npm/bullmq-dash@0.3.0 passed the Socket package score gate (all alerts are in the accepted set).",
    );
  });

  it("reports wrong-target and non-ok Socket responses as gate failures", () => {
    const rendered = renderScoreGateSummary({
      packageSpec: "bullmq-dash@0.3.0",
      expectedPurl: "pkg:npm/bullmq-dash@0.3.0",
      socketOk: false,
      socketPurl: "pkg:npm/other@1.0.0",
      alertCount: 0,
      alertTypes: [],
      acceptedAlertTypes: [],
      unexpectedAlertTypes: [],
      unexpectedAlerts: [],
      clean: false,
    });

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain("Socket ok: false");
    expect(rendered.stdout).toContain("Socket purl: pkg:npm/other@1.0.0");
    expect(rendered.stderr).toContain("Socket response not ok.");
    expect(rendered.stderr).toContain(
      "Socket target mismatch: expected pkg:npm/bullmq-dash@0.3.0, got pkg:npm/other@1.0.0.",
    );
  });
});

describe("isUnavailablePackageScoreError", () => {
  it("recognizes Socket package-score lookup failures for unpublished versions", () => {
    expect(isUnavailablePackageScoreError("fetch failed while calling purl/score")).toBe(true);
    expect(
      isUnavailablePackageScoreError("npm/bullmq-dash@0.3.0 is not available in the npm registry"),
    ).toBe(true);
    expect(
      isUnavailablePackageScoreError(
        "npm exec -- socket package score npm bullmq-dash@0.3.0 --json timed out after 30000ms",
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated Socket errors", () => {
    expect(isUnavailablePackageScoreError("invalid API token")).toBe(false);
  });
});
