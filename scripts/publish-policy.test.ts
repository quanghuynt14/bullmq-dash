import { describe, expect, it } from "bun:test";
import {
  BLOCKED_PUBLISHED_VERSIONS,
  BUN_PACKAGE_MANAGER,
  EXPECTED_RUNTIME_DEPENDENCIES,
  FORBIDDEN_SOURCE_MANIFEST_FIELDS,
  PACKAGE_BIN,
  PACKAGE_BUGS_URL,
  PACKAGE_FILES,
  PACKAGE_HOMEPAGE,
  PACKAGE_LICENSE,
  PACKAGE_MAIN,
  PACKAGE_NAME,
  PACKAGE_REPOSITORY_URL,
  PACKAGE_TYPE,
  POSTPACK_SCRIPT,
  POSTPUBLISH_SCRIPT,
  PREPACK_SCRIPT,
  PREPUBLISH_ONLY_SCRIPT,
  REMOVED_DIRECT_DEPENDENCIES,
  SECURITY_RELEASE_SCRIPT,
} from "./publish-policy.js";

// These tests pin the literal value of every gate-suite constant. The
// publish-manifest verifier asserts the package.json scripts equal the
// constants in this file — which means weakening a verifier by editing
// publish-policy.ts (e.g. dropping `security:verify-package` from
// PREPUBLISH_ONLY_SCRIPT) passes assertSourceManifest because the manifest
// still matches the (weakened) constant. The tests below break the self-
// reference: a PR that tampers with a constant must update this test too,
// and that change is visible to a reviewer / CODEOWNERS gate.
describe("publish-policy constants (literal pins)", () => {
  it("PACKAGE_NAME is bullmq-dash", () => {
    expect(PACKAGE_NAME).toBe("bullmq-dash");
  });

  it("PACKAGE_HOMEPAGE points at the project README", () => {
    expect(PACKAGE_HOMEPAGE).toBe("https://github.com/quanghuynt14/bullmq-dash#readme");
  });

  it("PACKAGE_BUGS_URL points at the project issues page", () => {
    expect(PACKAGE_BUGS_URL).toBe("https://github.com/quanghuynt14/bullmq-dash/issues");
  });

  it("PACKAGE_REPOSITORY_URL is the canonical git+https URL", () => {
    expect(PACKAGE_REPOSITORY_URL).toBe("git+https://github.com/quanghuynt14/bullmq-dash.git");
  });

  it("PACKAGE_LICENSE is MIT", () => {
    expect(PACKAGE_LICENSE).toBe("MIT");
  });

  it("PACKAGE_TYPE is module (ESM)", () => {
    expect(PACKAGE_TYPE).toBe("module");
  });

  it("PACKAGE_MAIN points at the bundled dist entrypoint", () => {
    expect(PACKAGE_MAIN).toBe("./dist/index.js");
  });

  it("PACKAGE_BIN points at the bundled dist entrypoint", () => {
    expect(PACKAGE_BIN).toBe("dist/index.js");
  });

  it("PACKAGE_FILES limits the tarball to the dist directory", () => {
    expect(PACKAGE_FILES).toEqual(["dist"]);
  });

  it("BUN_PACKAGE_MANAGER is pinned to a specific Bun version", () => {
    expect(BUN_PACKAGE_MANAGER).toBe("bun@1.3.13");
  });

  it("PREPACK_SCRIPT runs the manifest stripper", () => {
    expect(PREPACK_SCRIPT).toBe("bun scripts/publish-manifest.ts prepack");
  });

  it("POSTPACK_SCRIPT restores the source manifest after pack", () => {
    expect(POSTPACK_SCRIPT).toBe("bun scripts/publish-manifest.ts restore");
  });

  it("POSTPUBLISH_SCRIPT restores the source manifest after publish", () => {
    expect(POSTPUBLISH_SCRIPT).toBe("bun scripts/publish-manifest.ts restore");
  });

  // Hard-code the literal expected verifier chain rather than re-deriving it
  // from constants. A PR that drops, reorders, or renames any step in
  // publish-policy.ts must update this test — which is the whole point.
  it("PREPUBLISH_ONLY_SCRIPT runs the four pre-publish verifiers in the expected order", () => {
    expect(PREPUBLISH_ONLY_SCRIPT).toBe(
      "bun run security:verify-source-control && bun run security:verify-lockfile && bun run security:verify-workflows && bun run security:verify-package",
    );
  });

  it("SECURITY_RELEASE_SCRIPT runs the four pre-publish verifiers in order", () => {
    expect(SECURITY_RELEASE_SCRIPT).toBe(
      "bun run security:verify-source-control && bun run security:verify-lockfile && bun run security:verify-workflows && bun run security:verify-package",
    );
  });

  it("BLOCKED_PUBLISHED_VERSIONS lists every version this tree must not re-publish", () => {
    // Keep this list literal — npm enforces version immutability registry-side
    // but this tripwire is what surfaces a "do not re-cut this number" mistake
    // at prepack time rather than after `npm publish` has already failed.
    expect([...BLOCKED_PUBLISHED_VERSIONS]).toEqual(["0.2.7", "0.3.0"]);
  });

  it("FORBIDDEN_SOURCE_MANIFEST_FIELDS lists every graph-rewriting / bundling field", () => {
    // The exact set of forbidden manifest fields is the policy. Editing this
    // set is a deliberate decision that should not pass silently — pin it.
    expect([...FORBIDDEN_SOURCE_MANIFEST_FIELDS]).toEqual([
      "bundleDependencies",
      "bundledDependencies",
      "optionalDependencies",
      "overrides",
      "peerDependencies",
      "resolutions",
    ]);
  });

  it("EXPECTED_RUNTIME_DEPENDENCIES pins the runtime graph to exactly two deps", () => {
    // The published runtime graph is intentionally minimal: @opentui/core
    // for the TUI and bullmq for queue access. ioredis is transitive through
    // bullmq. Any addition here widens the Socket-scored graph and must be
    // a deliberate review decision, not a silent constant change.
    expect(EXPECTED_RUNTIME_DEPENDENCIES).toEqual({
      "@opentui/core": "^0.2.10",
      bullmq: "^5.76.8",
    });
  });

  it("REMOVED_DIRECT_DEPENDENCIES lists every direct dep we have deliberately dropped", () => {
    expect([...REMOVED_DIRECT_DEPENDENCIES]).toEqual(["ioredis", "zod"]);
  });
});
