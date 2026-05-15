import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

const packagePath = "./package.json";
const backupPath = "./.package.json.prepack-backup";

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(packagePath, "utf-8")) as Record<string, unknown>;
}

function writePackageJson(pkg: Record<string, unknown>): void {
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function assertSourceManifest(pkg: Record<string, unknown>): void {
  for (const field of FORBIDDEN_SOURCE_MANIFEST_FIELDS) {
    if (field in pkg) {
      throw new Error(
        `Refusing to publish: package.json must not use ${field}; release dependencies must be explicit and installable without local graph rewrites or bundling.`,
      );
    }
  }

  if (
    typeof pkg.version === "string" &&
    BLOCKED_PUBLISHED_VERSIONS.includes(pkg.version as (typeof BLOCKED_PUBLISHED_VERSIONS)[number])
  ) {
    throw new Error(
      `Refusing to publish: ${pkg.version} is already published and immutable. Bump package.json version first.`,
    );
  }

  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error("Refusing to publish: package.json is missing source scripts.");
  }

  const prepackScript = (scripts as Record<string, unknown>).prepack;
  if (prepackScript !== PREPACK_SCRIPT) {
    throw new Error("Refusing to publish: package.json prepack script is missing or unexpected.");
  }

  const prepublishOnlyScript = (scripts as Record<string, unknown>).prepublishOnly;
  if (prepublishOnlyScript !== PREPUBLISH_ONLY_SCRIPT) {
    throw new Error(
      "Refusing to publish: package.json prepublishOnly security verifier is missing or unexpected.",
    );
  }

  const securityReleaseScript = (scripts as Record<string, unknown>)["security:release"];
  if (securityReleaseScript !== SECURITY_RELEASE_SCRIPT) {
    throw new Error(
      "Refusing to publish: package.json security:release gate is missing or unexpected.",
    );
  }

  if (!pkg.devDependencies || typeof pkg.devDependencies !== "object") {
    throw new Error("Refusing to publish: package.json is missing source devDependencies.");
  }

  if (pkg.packageManager !== BUN_PACKAGE_MANAGER) {
    throw new Error(
      `Refusing to publish: package.json packageManager must be pinned to ${BUN_PACKAGE_MANAGER}.`,
    );
  }

  const publishConfig = pkg.publishConfig;
  if (
    !publishConfig ||
    typeof publishConfig !== "object" ||
    Array.isArray(publishConfig) ||
    (publishConfig as Record<string, unknown>).provenance !== true
  ) {
    throw new Error("Refusing to publish: package.json publishConfig.provenance must be true.");
  }

  const repository = pkg.repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository) ||
    (repository as Record<string, unknown>).url !== PACKAGE_REPOSITORY_URL
  ) {
    throw new Error("Refusing to publish: package.json repository URL is missing or unexpected.");
  }

  const bugs = pkg.bugs;
  if (
    !bugs ||
    typeof bugs !== "object" ||
    Array.isArray(bugs) ||
    (bugs as Record<string, unknown>).url !== PACKAGE_BUGS_URL
  ) {
    throw new Error("Refusing to publish: package.json bugs URL is missing or unexpected.");
  }

  if (pkg.homepage !== PACKAGE_HOMEPAGE) {
    throw new Error("Refusing to publish: package.json homepage is missing or unexpected.");
  }

  const dependencies = pkg.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("Refusing to publish: package.json is missing runtime dependencies.");
  }

  const dependencyMap = dependencies as Record<string, unknown>;
  for (const [name, version] of Object.entries(EXPECTED_RUNTIME_DEPENDENCIES)) {
    if (dependencyMap[name] !== version) {
      throw new Error(`Refusing to publish: ${name} must be pinned to ${version}.`);
    }
  }

  for (const removed of REMOVED_DIRECT_DEPENDENCIES) {
    if (removed in dependencyMap) {
      throw new Error(`Refusing to publish: direct dependency ${removed} was reintroduced.`);
    }
  }

  const expectedDependencyNames = new Set(Object.keys(EXPECTED_RUNTIME_DEPENDENCIES));
  for (const name of Object.keys(dependencyMap)) {
    if (!expectedDependencyNames.has(name)) {
      throw new Error(`Refusing to publish: unexpected runtime dependency ${name}.`);
    }
  }
}

function restoreManifest(): void {
  if (!existsSync(backupPath)) return;

  writeFileSync(packagePath, readFileSync(backupPath, "utf-8"));
  unlinkSync(backupPath);
  assertSourceManifest(readPackageJson());
}

async function prepack(): Promise<void> {
  if (existsSync(backupPath)) {
    throw new Error(
      `Refusing to prepack while ${backupPath} exists. Run 'bun scripts/publish-manifest.ts restore' first.`,
    );
  }

  const pkg = readPackageJson();
  assertSourceManifest(pkg);

  await import("../build.ts");

  writeFileSync(backupPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // Keep "files": npm reads it from this temporary manifest to decide what
  // goes into the tarball. Removing it widens the package to repo/docs files.
  delete pkg.devDependencies;
  delete pkg.packageManager;
  delete pkg.scripts;
  writePackageJson(pkg);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "prepack") {
    await prepack();
  } else if (command === "restore") {
    restoreManifest();
  } else {
    throw new Error("Usage: bun scripts/publish-manifest.ts <prepack|restore>");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (process.argv[2] === "prepack") {
      restoreManifest();
    }

    throw error;
  }
}
