import { describe, expect, it } from "bun:test";
import {
  assertNoForbiddenPackedManifestFields,
  FORBIDDEN_PACKED_MANIFEST_FIELDS,
  PACKED_MANIFEST_POLICY_MESSAGE,
} from "./packed-manifest-policy.js";

describe("assertNoForbiddenPackedManifestFields", () => {
  it("accepts a minimal packed manifest without local-only or graph rewrite fields", () => {
    expect(() =>
      assertNoForbiddenPackedManifestFields({
        name: "bullmq-dash",
        version: "0.3.0",
        dependencies: {
          "@opentui/core": "0.2.10",
          bullmq: "5.76.8",
        },
      }),
    ).not.toThrow();
  });

  it("rejects stripped source fields, graph rewrites, and bundling fields", () => {
    for (const field of FORBIDDEN_PACKED_MANIFEST_FIELDS) {
      expect(() => assertNoForbiddenPackedManifestFields({ [field]: {} })).toThrow(
        `Packed package.json must not contain ${field}`,
      );
    }
  });

  it("rejects an already-published immutable package version", () => {
    expect(() =>
      assertNoForbiddenPackedManifestFields({
        name: "bullmq-dash",
        version: "0.2.7",
      }),
    ).toThrow("Packed package.json must not use already-published immutable version 0.2.7");
  });

  it("formats the verifier evidence consistently", () => {
    expect(PACKED_MANIFEST_POLICY_MESSAGE).toBe(
      "devDependencies, scripts, packageManager, types, graph rewrites, and bundling fields stripped; blocked immutable versions rejected",
    );
  });
});
