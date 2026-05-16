import { describe, expect, it } from "bun:test";
import { assertSourceManifest } from "./publish-manifest.js";
import {
  BLOCKED_PUBLISHED_VERSIONS,
  BUN_PACKAGE_MANAGER,
  EXPECTED_RUNTIME_DEPENDENCIES,
  FORBIDDEN_SOURCE_MANIFEST_FIELDS,
  PACKAGE_BUGS_URL,
  PACKAGE_HOMEPAGE,
  PACKAGE_REPOSITORY_URL,
  PREPACK_SCRIPT,
  PREPUBLISH_ONLY_SCRIPT,
  REMOVED_DIRECT_DEPENDENCIES,
  SECURITY_RELEASE_SCRIPT,
} from "./publish-policy.js";
import { getRuntimeSourcePolicyViolations } from "./runtime-source-policy.js";

function validManifest(): Record<string, unknown> {
  return {
    name: "bullmq-dash",
    version: "0.3.0",
    homepage: PACKAGE_HOMEPAGE,
    bugs: {
      url: PACKAGE_BUGS_URL,
    },
    repository: {
      type: "git",
      url: PACKAGE_REPOSITORY_URL,
    },
    publishConfig: {
      provenance: true,
    },
    scripts: {
      prepack: PREPACK_SCRIPT,
      prepublishOnly: PREPUBLISH_ONLY_SCRIPT,
      "security:release": SECURITY_RELEASE_SCRIPT,
    },
    dependencies: { ...EXPECTED_RUNTIME_DEPENDENCIES },
    devDependencies: {
      typescript: "^6.0.3",
    },
    packageManager: BUN_PACKAGE_MANAGER,
  };
}

describe("assertSourceManifest", () => {
  it("accepts the expected source manifest security shape", () => {
    expect(() => assertSourceManifest(validManifest())).not.toThrow();
  });

  it("rejects reintroduced direct runtime dependencies", () => {
    for (const dependency of REMOVED_DIRECT_DEPENDENCIES) {
      const manifest = validManifest();
      manifest.dependencies = {
        ...(manifest.dependencies as Record<string, string>),
        [dependency]: "1.0.0",
      };

      expect(() => assertSourceManifest(manifest)).toThrow(
        `Refusing to publish: direct dependency ${dependency} was reintroduced.`,
      );
    }
  });

  it("rejects unpinned runtime dependency drift", () => {
    const manifest = validManifest();
    manifest.dependencies = {
      ...(manifest.dependencies as Record<string, string>),
      bullmq: "^5.0.0",
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: bullmq must be pinned to ^5.76.8.",
    );
  });

  it("rejects unexpected runtime dependencies that widen the Socket score graph", () => {
    const manifest = validManifest();
    manifest.dependencies = {
      ...(manifest.dependencies as Record<string, string>),
      chalk: "5.6.2",
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: unexpected runtime dependency chalk.",
    );
  });

  it("rejects manifest graph rewrites and bundling fields", () => {
    for (const field of FORBIDDEN_SOURCE_MANIFEST_FIELDS) {
      const manifest = validManifest();
      manifest[field] = {};

      expect(() => assertSourceManifest(manifest)).toThrow(
        `Refusing to publish: package.json must not use ${field}; release dependencies must be explicit and installable without local graph rewrites or bundling.`,
      );
    }
  });

  it("rejects the already-published immutable security target version", () => {
    const manifest = validManifest();
    manifest.version = BLOCKED_PUBLISHED_VERSIONS[0];

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: 0.2.7 is already published and immutable. Bump package.json version first.",
    );
  });

  it("rejects a missing prepublishOnly verifier", () => {
    const manifest = validManifest();
    manifest.scripts = {
      prepack: PREPACK_SCRIPT,
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json prepublishOnly security verifier is missing or unexpected.",
    );
  });

  // The gate is strict equality against PREPUBLISH_ONLY_SCRIPT, so any deviation
  // — reordered verifiers, an extra step, a dropped step, a typo — must throw.
  // These cases all probe the strict-equality contract rather than asserting
  // granular ordering the gate doesn't actually have.
  it("rejects a prepublishOnly verifier that drops one of the expected steps", () => {
    const manifest = validManifest();
    manifest.scripts = {
      ...(manifest.scripts as Record<string, string>),
      prepublishOnly:
        "bun run security:verify-source-control && bun run security:verify-lockfile && bun run security:verify-workflows",
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json prepublishOnly security verifier is missing or unexpected.",
    );
  });

  it("rejects a prepublishOnly verifier that adds an extra step", () => {
    const manifest = validManifest();
    manifest.scripts = {
      ...(manifest.scripts as Record<string, string>),
      prepublishOnly: `${PREPUBLISH_ONLY_SCRIPT} && bun run security:score`,
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json prepublishOnly security verifier is missing or unexpected.",
    );
  });

  it("rejects a prepublishOnly verifier that reorders the expected steps", () => {
    const manifest = validManifest();
    manifest.scripts = {
      ...(manifest.scripts as Record<string, string>),
      prepublishOnly:
        "bun run security:verify-lockfile && bun run security:verify-source-control && bun run security:verify-workflows && bun run security:verify-package",
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json prepublishOnly security verifier is missing or unexpected.",
    );
  });

  it("rejects a missing security:release gate", () => {
    const manifest = validManifest();
    manifest.scripts = {
      prepack: PREPACK_SCRIPT,
      prepublishOnly: PREPUBLISH_ONLY_SCRIPT,
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json security:release gate is missing or unexpected.",
    );
  });

  it("rejects a security:release gate that drops one of the expected steps", () => {
    const manifest = validManifest();
    manifest.scripts = {
      ...(manifest.scripts as Record<string, string>),
      "security:release":
        "bun run security:verify-source-control && bun run security:verify-lockfile && bun run security:verify-workflows && bun run security:verify-package",
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json security:release gate is missing or unexpected.",
    );
  });

  it("rejects a security:release gate that reorders the expected steps", () => {
    const manifest = validManifest();
    manifest.scripts = {
      ...(manifest.scripts as Record<string, string>),
      "security:release": `bun run security:score && ${PREPUBLISH_ONLY_SCRIPT}`,
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json security:release gate is missing or unexpected.",
    );
  });

  it("rejects package manager drift", () => {
    const manifest = validManifest();
    manifest.packageManager = "bun@1.3.12";

    expect(() => assertSourceManifest(manifest)).toThrow(
      `Refusing to publish: package.json packageManager must be pinned to ${BUN_PACKAGE_MANAGER}.`,
    );
  });

  it("rejects missing provenance publishing metadata", () => {
    const manifest = validManifest();
    manifest.publishConfig = {};

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json publishConfig.provenance must be true.",
    );
  });

  it("rejects missing repository metadata", () => {
    const manifest = validManifest();
    manifest.repository = {
      type: "git",
      url: "https://github.com/quanghuynt14/bullmq-dash",
    };

    expect(() => assertSourceManifest(manifest)).toThrow(
      "Refusing to publish: package.json repository URL is missing or unexpected.",
    );
  });
});

describe("runtime dependency policy", () => {
  it("keeps removed direct dependencies out of runtime source imports", () => {
    expect(getRuntimeSourcePolicyViolations()).toEqual([]);
  });
});
