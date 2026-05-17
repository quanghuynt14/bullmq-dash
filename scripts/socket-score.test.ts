import { describe, expect, it } from "bun:test";
import {
  ACCEPTED_ALERT_TYPES,
  buildScoreGateSummary,
  classifyScoreError,
  EXIT_TEMPFAIL,
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

  it("recognizes transient HTTP failures from the score endpoint", () => {
    // Socket may briefly return a 5xx or 429 while propagating a freshly
    // published version. These are legitimate retry targets.
    expect(isUnavailablePackageScoreError("purl/score endpoint returned HTTP 503")).toBe(true);
    expect(isUnavailablePackageScoreError("purl/score endpoint returned status 429")).toBe(true);
    expect(isUnavailablePackageScoreError("purl/score endpoint reports version not indexed")).toBe(
      true,
    );
  });

  it("does not swallow unrelated Socket errors", () => {
    // Plain auth failures must surface immediately, not enter the retry loop.
    expect(isUnavailablePackageScoreError("invalid API token")).toBe(false);
  });

  it("does not reclassify permanent Socket errors that merely mention purl/score", () => {
    // Regression guard: the previous classifier used a substring OR including
    // a bare `purl/score`, so any Socket-side auth or config error that hit
    // the score endpoint was retried five times before failing. Anchor the
    // signal: an endpoint reference alone is not enough — it must coincide
    // with a transient-failure marker (timeout, 5xx, fetch failed, etc.).
    expect(isUnavailablePackageScoreError("401 Unauthorized calling purl/score endpoint")).toBe(
      false,
    );
    expect(
      isUnavailablePackageScoreError("Socket authentication failed for purl/score request"),
    ).toBe(false);
    expect(isUnavailablePackageScoreError("purl/score endpoint rejected the API token")).toBe(
      false,
    );
  });

  it("does not reclassify a stray 'fetch failed' from unrelated network code", () => {
    // The classifier should not mark every "fetch failed" as a Socket-score
    // tempfail — only ones paired with the score-endpoint context.
    expect(isUnavailablePackageScoreError("fetch failed contacting GitHub API")).toBe(false);
    expect(isUnavailablePackageScoreError("TypeError: fetch failed")).toBe(false);
  });

  it("does not reclassify mentions of 'timed out' that aren't the run-helper signal", () => {
    // The run() helper's exact timeout template is `... timed out after Nms`.
    // A user-facing message that merely mentions a timeout in passing must
    // not enter the retry loop.
    expect(isUnavailablePackageScoreError("connection eventually timed out")).toBe(false);
    expect(
      isUnavailablePackageScoreError("Socket reports the upstream API timed out yesterday"),
    ).toBe(false);
  });
});

// Pins the publish-workflow retry-loop contract end-to-end. The retry loop
// in .github/workflows/publish.yml retries iff the script exits 75 and
// aborts publish on any other nonzero exit. If a future refactor rewires
// the dispatch (so a real gate failure routes to EXIT_TEMPFAIL, or a
// transient lookup throws instead of returning 75), every other test
// passes but the retry budget either burns silently on real failures or
// surfaces ghost errors during real-flake recoveries.
describe("classifyScoreError", () => {
  it("pins EXIT_TEMPFAIL to 75 (POSIX EX_TEMPFAIL) for shell-level distinguishability", () => {
    expect(EXIT_TEMPFAIL).toBe(75);
  });

  it("routes Socket lookup-unavailable errors to tempfail (retry)", () => {
    expect(classifyScoreError(new Error("fetch failed while calling purl/score"))).toBe("tempfail");
    expect(
      classifyScoreError(new Error("npm/bullmq-dash@0.3.0 is not available in the npm registry")),
    ).toBe("tempfail");
    expect(classifyScoreError(new Error("socket package score timed out after 30000ms"))).toBe(
      "tempfail",
    );
  });

  it("routes every other error class to rethrow (hard fail, no retry)", () => {
    // Real gate failures must surface as exit 1, not exit 75 — otherwise
    // the publish workflow's retry loop swallows them as transient flakes
    // and the release ships unscored.
    expect(classifyScoreError(new Error("invalid API token"))).toBe("rethrow");
    expect(classifyScoreError(new Error("ENOENT: spawn npm not found"))).toBe("rethrow");
    expect(
      classifyScoreError(new Error("Socket reports unexpected alert types: criticalCVE")),
    ).toBe("rethrow");
  });

  it("routes non-Error throws (strings, undefined) to rethrow rather than tempfail", () => {
    // Defensive: if something throws a non-Error (e.g. `throw 'oops'`),
    // we'd rather hard-fail than mistakenly retry.
    expect(classifyScoreError("invalid API token")).toBe("rethrow");
    expect(classifyScoreError(undefined)).toBe("rethrow");
    expect(classifyScoreError(null)).toBe("rethrow");
  });
});
