import { BLOCKED_PUBLISHED_VERSIONS, FORBIDDEN_SOURCE_MANIFEST_FIELDS } from "./publish-policy.js";

export const PACKED_MANIFEST_POLICY_MESSAGE =
  "devDependencies, scripts, packageManager, types, graph rewrites, and bundling fields stripped; blocked immutable versions rejected";

export const FORBIDDEN_PACKED_MANIFEST_FIELDS = [
  "scripts",
  "devDependencies",
  "packageManager",
  "types",
  ...FORBIDDEN_SOURCE_MANIFEST_FIELDS,
] as const;

export function assertNoForbiddenPackedManifestFields(pkg: Record<string, unknown>): void {
  if (
    typeof pkg.version === "string" &&
    BLOCKED_PUBLISHED_VERSIONS.includes(pkg.version as (typeof BLOCKED_PUBLISHED_VERSIONS)[number])
  ) {
    throw new Error(
      `Packed package.json must not use already-published immutable version ${pkg.version}`,
    );
  }

  for (const key of FORBIDDEN_PACKED_MANIFEST_FIELDS) {
    if (key in pkg) {
      throw new Error(`Packed package.json must not contain ${key}`);
    }
  }
}
