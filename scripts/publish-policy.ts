export const PACKAGE_NAME = "bullmq-dash";
export const PACKAGE_HOMEPAGE = "https://github.com/quanghuynt14/bullmq-dash#readme";
export const PACKAGE_BUGS_URL = "https://github.com/quanghuynt14/bullmq-dash/issues";
export const PACKAGE_REPOSITORY_URL = "git+https://github.com/quanghuynt14/bullmq-dash.git";
export const PACKAGE_LICENSE = "MIT";
export const PACKAGE_TYPE = "module";
export const PACKAGE_MAIN = "./dist/index.js";
export const PACKAGE_BIN = "dist/index.js";
export const PACKAGE_FILES = ["dist"] as const;
export const BUN_PACKAGE_MANAGER = "bun@1.3.13";
export const PREPACK_SCRIPT = "bun scripts/publish-manifest.ts prepack";
export const PREPUBLISH_ONLY_SCRIPT =
  "bun run security:verify-source-control && bun run security:verify-lockfile && bun run security:verify-workflows && bun run security:verify-package";
export const SECURITY_RELEASE_SCRIPT =
  "bun run security:verify-source-control && bun run security:verify-lockfile && bun run security:verify-workflows && bun run security:verify-package && bun run security:score";
export const BLOCKED_PUBLISHED_VERSIONS = ["0.2.7"] as const;
export const FORBIDDEN_SOURCE_MANIFEST_FIELDS = [
  "bundleDependencies",
  "bundledDependencies",
  "optionalDependencies",
  "overrides",
  "peerDependencies",
  "resolutions",
] as const;

export const EXPECTED_RUNTIME_DEPENDENCIES: Record<string, string> = {
  "@opentui/core": "^0.2.10",
  bullmq: "^5.76.8",
};

export const REMOVED_DIRECT_DEPENDENCIES = ["ioredis", "zod"] as const;
