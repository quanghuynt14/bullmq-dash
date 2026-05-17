import { describe, expect, it } from "bun:test";
import {
  buildAuditSummary,
  parseJsonFromNoisyOutput,
  renderAuditSummary,
  type NpmView,
  type SocketScore,
} from "./audit-socket-target.js";

const dirtyNpmView: NpmView = {
  name: "bullmq-dash",
  version: "0.2.7",
  versions: ["0.1.0", "0.2.7", "0.3.0"],
  time: {
    "0.2.7": "2026-05-09T14:54:32.141Z",
  },
  dist: {
    integrity:
      "sha512-+Vs8adxHLFrIS3QBsQTGMYZoVP06vSg7Kw02iAm1QS+jV5tdTgIlqGftDkKaPKP2jZgDeS/MlPb5VH77puYf5g==",
    tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.2.7.tgz",
  },
  dependencies: {
    "@opentui/core": "^0.2.4",
    bullmq: "^5.76.6",
    ioredis: "^5.10.1",
    zod: "^4.4.3",
  },
};

const dirtySocketScore: SocketScore = {
  ok: true,
  data: {
    purl: "pkg:npm/bullmq-dash@0.2.7",
    self: {
      alerts: [{ severity: "middle", name: "networkAccess", example: "npm/bullmq-dash@0.2.7" }],
    },
    transitively: {
      dependencyCount: 46,
      alerts: [
        { severity: "high", name: "obfuscatedFile", example: "npm/ioredis@5.10.1" },
        { severity: "middle", name: "recentlyPublished", example: "npm/zod@4.4.3" },
      ],
    },
  },
};

describe("parseJsonFromNoisyOutput", () => {
  it("extracts JSON from Socket progress output", () => {
    const parsed = parseJsonFromNoisyOutput<{ ok: boolean }>('spinner text\n{"ok":true}\n');
    expect(parsed).toEqual({ ok: true });
  });

  it("extracts JSON arrays from npm pack progress output", () => {
    const parsed = parseJsonFromNoisyOutput<Array<{ filename: string }>>(
      'npm notice\n[{"filename":"bullmq-dash-0.2.7.tgz"}]\n',
    );
    expect(parsed).toEqual([{ filename: "bullmq-dash-0.2.7.tgz" }]);
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseJsonFromNoisyOutput("spinner text only")).toThrow(
      "Expected JSON value in command output",
    );
  });
});

describe("buildAuditSummary", () => {
  it("marks the immutable 0.2.7 target dirty when alerts and removed dependencies remain", () => {
    const summary = buildAuditSummary(dirtyNpmView, dirtySocketScore);

    expect(summary.clean).toBe(false);
    expect(summary.socketCliVersion).toBe("unknown");
    expect(summary.socketOk).toBe(true);
    expect(summary.socketPurl).toBe("pkg:npm/bullmq-dash@0.2.7");
    expect(summary.targetMismatch).toBe(false);
    expect(summary.publishedName).toBe("bullmq-dash");
    expect(summary.expectedName).toBe("bullmq-dash");
    expect(summary.nameMismatch).toBe(false);
    expect(summary.versionMismatch).toBe(false);
    expect(summary.deprecated).toBe(false);
    expect(summary.deprecationMessage).toBe("none");
    expect(summary.registryVersionCount).toBe(3);
    expect(summary.targetVersionListed).toBe(true);
    expect(summary.registryVersionMissing).toBe(false);
    expect(summary.tarballUrlMismatch).toBe(false);
    expect(summary.alertCount).toBe(3);
    expect(summary.selfAlertCount).toBe(1);
    expect(summary.transitiveAlertCount).toBe(2);
    expect(summary.publishedAt).toBe("2026-05-09T14:54:32.141Z");
    expect(summary.tarballIntegrity).toStartWith("sha512-");
    expect(summary.tarballUrl).toBe(
      "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.2.7.tgz",
    );
    expect(summary.tarballManifestName).toBe("bullmq-dash");
    expect(summary.tarballManifestVersion).toBe("0.2.7");
    expect(summary.tarballManifestMismatch).toBe(false);
    expect(summary.tarballManifestDependencySpecs).toEqual([
      "@opentui/core@^0.2.4",
      "bullmq@^5.76.6",
      "ioredis@^5.10.1",
      "zod@^4.4.3",
    ]);
    expect(summary.tarballManifestDependencyFindings).toEqual(["ioredis", "zod"]);
    expect(summary.dependencyCount).toBe("46");
    expect(summary.severityCounts).toEqual({ high: 1, middle: 2 });
    expect(summary.alertNameCounts).toEqual({
      networkAccess: 1,
      obfuscatedFile: 1,
      recentlyPublished: 1,
    });
    expect(summary.selfAlertNameCounts).toEqual({ networkAccess: 1 });
    expect(summary.transitiveAlertNameCounts).toEqual({
      obfuscatedFile: 1,
      recentlyPublished: 1,
    });
    expect(summary.directDependencies).toEqual(["@opentui/core", "bullmq", "ioredis", "zod"]);
    expect(summary.directDependencySpecs).toEqual([
      "@opentui/core@^0.2.4",
      "bullmq@^5.76.6",
      "ioredis@^5.10.1",
      "zod@^4.4.3",
    ]);
    expect(summary.immutableDependencyFindings).toEqual(["ioredis", "zod"]);
    expect(summary.topAlerts).toContain("high obfuscatedFile (npm/ioredis@5.10.1)");
  });

  it("marks a target clean only when no alerts and removed dependencies remain", () => {
    const summary = buildAuditSummary(
      {
        name: "bullmq-dash",
        version: "0.3.0",
        versions: ["0.2.7", "0.3.0"],
        time: {
          "0.3.0": "2026-05-14T00:00:00.000Z",
        },
        dist: {
          integrity: "sha512-clean",
          tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz",
        },
        dependencies: {
          "@opentui/core": "0.2.9",
          bullmq: "5.76.8",
        },
      },
      {
        ok: true,
        data: {
          purl: "pkg:npm/bullmq-dash@0.3.0",
          transitively: {
            dependencyCount: 2,
            alerts: [],
          },
        },
      },
      "bullmq-dash@0.3.0",
    );

    expect(summary.clean).toBe(true);
    expect(summary.socketOk).toBe(true);
    expect(summary.targetMismatch).toBe(false);
    expect(summary.nameMismatch).toBe(false);
    expect(summary.versionMismatch).toBe(false);
    expect(summary.deprecated).toBe(false);
    expect(summary.deprecationMessage).toBe("none");
    expect(summary.registryVersionCount).toBe(2);
    expect(summary.targetVersionListed).toBe(true);
    expect(summary.registryVersionMissing).toBe(false);
    expect(summary.tarballUrlMismatch).toBe(false);
    expect(summary.tarballManifestMismatch).toBe(false);
    expect(summary.alertCount).toBe(0);
    expect(summary.selfAlertCount).toBe(0);
    expect(summary.transitiveAlertCount).toBe(0);
    expect(summary.publishedAt).toBe("2026-05-14T00:00:00.000Z");
    expect(summary.immutableDependencyFindings).toEqual([]);
    expect(summary.tarballManifestDependencyFindings).toEqual([]);
  });

  it("records npm deprecation metadata without treating deprecation as a clean score", () => {
    const summary = buildAuditSummary(
      {
        ...dirtyNpmView,
        deprecated: "Security: use bullmq-dash@0.3.0 or later.",
      },
      dirtySocketScore,
    );

    expect(summary.clean).toBe(false);
    expect(summary.deprecated).toBe(true);
    expect(summary.deprecationMessage).toBe("Security: use bullmq-dash@0.3.0 or later.");
    expect(summary.alertCount).toBe(3);
    expect(summary.immutableDependencyFindings).toEqual(["ioredis", "zod"]);
  });
});

describe("renderAuditSummary", () => {
  it("returns exit 1 with concrete evidence for a dirty target", () => {
    const rendered = renderAuditSummary(buildAuditSummary(dirtyNpmView, dirtySocketScore));

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain("Socket CLI version: unknown");
    expect(rendered.stdout).toContain("Socket ok: true");
    expect(rendered.stdout).toContain("Socket purl: pkg:npm/bullmq-dash@0.2.7");
    expect(rendered.stdout).toContain("Published name: bullmq-dash");
    expect(rendered.stdout).toContain("Deprecated: false");
    expect(rendered.stdout).toContain("Deprecation message: none");
    expect(rendered.stdout).toContain("Registry version count: 3");
    expect(rendered.stdout).toContain("Target version listed: true");
    expect(rendered.stdout).toContain("Published at: 2026-05-09T14:54:32.141Z");
    expect(rendered.stdout).toContain(
      "Tarball integrity: sha512-+Vs8adxHLFrIS3QBsQTGMYZoVP06vSg7Kw02iAm1QS+jV5tdTgIlqGftDkKaPKP2jZgDeS/MlPb5VH77puYf5g==",
    );
    expect(rendered.stdout).toContain(
      "Tarball URL: https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.2.7.tgz",
    );
    expect(rendered.stdout).toContain("Registry tarball manifest name: bullmq-dash");
    expect(rendered.stdout).toContain("Registry tarball manifest version: 0.2.7");
    expect(rendered.stdout).toContain(
      "Registry tarball manifest dependency specs: @opentui/core@^0.2.4, bullmq@^5.76.6, ioredis@^5.10.1, zod@^4.4.3",
    );
    expect(rendered.stdout).toContain("Alert count: 3");
    expect(rendered.stdout).toContain("Package-self alert count: 1");
    expect(rendered.stdout).toContain("Transitive alert count: 2");
    expect(rendered.stdout).toContain(
      "Direct dependency specs: @opentui/core@^0.2.4, bullmq@^5.76.6, ioredis@^5.10.1, zod@^4.4.3",
    );
    expect(rendered.stdout).toContain("Alert severities: high=1, middle=2");
    expect(rendered.stdout).toContain(
      "Alert types: networkAccess=1, obfuscatedFile=1, recentlyPublished=1",
    );
    expect(rendered.stdout).toContain("Package-self alert types: networkAccess=1");
    expect(rendered.stdout).toContain(
      "Transitive alert types: obfuscatedFile=1, recentlyPublished=1",
    );
    expect(rendered.stdout).toContain(
      "Immutable target still has removed direct dependencies: ioredis, zod",
    );
    expect(rendered.stdout).toContain(
      "Registry tarball manifest still has removed direct dependencies: ioredis, zod",
    );
    expect(rendered.stdout).toContain(
      "npm/bullmq-dash@0.2.7 is not clean. This command scores the already-published registry artifact, not the local worktree.",
    );
  });

  it("returns exit 1 when Socket returns a different target purl", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.3.0",
          versions: ["0.3.0"],
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/other-package@1.0.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain(
      "Socket target mismatch: expected pkg:npm/bullmq-dash@0.3.0, got pkg:npm/other-package@1.0.0",
    );
  });

  it("returns exit 1 when Socket JSON response is not ok", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.3.0",
          versions: ["0.3.0"],
          dist: {
            tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz",
          },
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: false,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain("Socket ok: false");
    expect(rendered.stdout).toContain("Socket response not ok");
    expect(rendered.stdout).toContain(
      "npm/bullmq-dash@0.3.0 is not clean. This command scores the already-published registry artifact, not the local worktree.",
    );
  });

  it("returns exit 1 when npm returns a different published version", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.2.9",
          versions: ["0.3.0", "0.2.9"],
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain("Published version mismatch: expected 0.3.0, got 0.2.9");
  });

  it("returns exit 1 when npm returns a different package name", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "other-package",
          version: "0.3.0",
          versions: ["0.3.0"],
          dist: {
            tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz",
          },
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain(
      "Published name mismatch: expected bullmq-dash, got other-package",
    );
  });

  it("returns exit 1 when the registry version list does not include the target version", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.3.0",
          versions: ["0.2.7"],
          dist: {
            tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz",
          },
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain("Registry version count: 1");
    expect(rendered.stdout).toContain("Target version listed: false");
    expect(rendered.stdout).toContain("Registry version list does not include 0.3.0");
  });

  it("returns exit 1 when npm returns a different tarball URL", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.3.0",
          versions: ["0.3.0"],
          dist: {
            tarball: "https://registry.npmjs.org/bullmq-dash/-/unexpected.tgz",
          },
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain(
      "Tarball URL mismatch: expected https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz, got https://registry.npmjs.org/bullmq-dash/-/unexpected.tgz",
    );
  });

  it("returns exit 1 when the registry tarball manifest identity differs", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.3.0",
          versions: ["0.3.0"],
          dist: {
            tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz",
          },
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
        "unknown",
        {
          name: "other-package",
          version: "0.3.0",
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain(
      "Registry tarball manifest mismatch: expected bullmq-dash@0.3.0, got other-package@0.3.0",
    );
  });

  it("returns exit 1 when the registry tarball manifest still contains removed dependencies", () => {
    const rendered = renderAuditSummary(
      buildAuditSummary(
        {
          name: "bullmq-dash",
          version: "0.3.0",
          versions: ["0.3.0"],
          dist: {
            tarball: "https://registry.npmjs.org/bullmq-dash/-/bullmq-dash-0.3.0.tgz",
          },
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
          },
        },
        {
          ok: true,
          data: {
            purl: "pkg:npm/bullmq-dash@0.3.0",
            transitively: {
              dependencyCount: 2,
              alerts: [],
            },
          },
        },
        "bullmq-dash@0.3.0",
        "unknown",
        {
          name: "bullmq-dash",
          version: "0.3.0",
          dependencies: {
            "@opentui/core": "0.2.9",
            bullmq: "5.76.8",
            zod: "4.4.3",
          },
        },
      ),
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.stdout).toContain(
      "Registry tarball manifest still has removed direct dependencies: zod",
    );
  });
});
