import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoCredentialedRedisUrls } from "./credentialed-url-policy.js";
import { getLockfilePolicyViolations } from "./lockfile-policy.js";
import {
  assertNoForbiddenPackedManifestFields,
  PACKED_MANIFEST_POLICY_MESSAGE,
} from "./packed-manifest-policy.js";
import { assertPackMetadataPolicy, formatPackMetadata } from "./pack-metadata-policy.js";
import { assertPackedEntrypointPolicy } from "./packed-entrypoint-policy.js";
import { assertSourceManifest } from "./publish-manifest.js";
import {
  EXPECTED_RUNTIME_DEPENDENCIES,
  PACKAGE_BIN,
  PACKAGE_BUGS_URL,
  PACKAGE_FILES,
  PACKAGE_HOMEPAGE,
  PACKAGE_LICENSE,
  PACKAGE_MAIN,
  PACKAGE_NAME,
  PACKAGE_REPOSITORY_URL,
  PACKAGE_TYPE,
  REMOVED_DIRECT_DEPENDENCIES,
} from "./publish-policy.js";
import {
  assertNoRemovedDependencyReferences,
  assertRuntimeSourcePolicy,
} from "./runtime-source-policy.js";

interface PackResult {
  filename?: unknown;
  integrity?: unknown;
  size?: unknown;
  unpackedSize?: unknown;
  entryCount?: unknown;
  bundled?: unknown;
}

const expectedFiles = new Set([
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.js",
  "package/package.json",
]);

async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${stderr.trimEnd()}`);
  }

  return { stdout, stderr };
}

async function getTrackedFiles(): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertDependencies(pkg: Record<string, unknown>): void {
  const dependencies = pkg.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("Packed package.json must contain dependencies");
  }

  const dependencyMap = dependencies as Record<string, unknown>;
  for (const [name, version] of Object.entries(EXPECTED_RUNTIME_DEPENDENCIES)) {
    if (dependencyMap[name] !== version) {
      throw new Error(`Packed package.json dependency ${name} must be pinned to ${version}`);
    }
  }

  for (const removed of REMOVED_DIRECT_DEPENDENCIES) {
    if (removed in dependencyMap) {
      throw new Error(`Packed package.json must not contain direct dependency ${removed}`);
    }
  }

  const expectedDependencyNames = new Set(Object.keys(EXPECTED_RUNTIME_DEPENDENCIES));
  for (const name of Object.keys(dependencyMap)) {
    if (!expectedDependencyNames.has(name)) {
      throw new Error(`Packed package.json must not contain unexpected dependency ${name}`);
    }
  }
}

function getDependencySpecs(pkg: Record<string, unknown>): string[] {
  const dependencies = pkg.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return [];
  }

  return Object.entries(dependencies).map(([name, version]) => `${name}@${String(version)}`);
}

function assertPackageMetadata(pkg: Record<string, unknown>): void {
  if (pkg.name !== PACKAGE_NAME) {
    throw new Error("Packed package.json name must be bullmq-dash");
  }

  if (pkg.type !== PACKAGE_TYPE) {
    throw new Error("Packed package.json type must be module");
  }

  if (pkg.main !== PACKAGE_MAIN) {
    throw new Error("Packed package.json main must be ./dist/index.js");
  }

  const bin = pkg.bin;
  if (
    !bin ||
    typeof bin !== "object" ||
    Array.isArray(bin) ||
    (bin as Record<string, unknown>)[PACKAGE_NAME] !== PACKAGE_BIN
  ) {
    throw new Error("Packed package.json bin.bullmq-dash must be dist/index.js");
  }

  if (
    !Array.isArray(pkg.files) ||
    pkg.files.length !== PACKAGE_FILES.length ||
    pkg.files[0] !== PACKAGE_FILES[0]
  ) {
    throw new Error("Packed package.json files must contain only dist");
  }

  if (pkg.license !== PACKAGE_LICENSE) {
    throw new Error("Packed package.json license must be MIT");
  }

  if (pkg.homepage !== PACKAGE_HOMEPAGE) {
    throw new Error("Packed package.json homepage is missing or unexpected");
  }

  const repository = pkg.repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository) ||
    (repository as Record<string, unknown>).url !== PACKAGE_REPOSITORY_URL
  ) {
    throw new Error("Packed package.json repository URL is missing or unexpected");
  }

  const bugs = pkg.bugs;
  if (
    !bugs ||
    typeof bugs !== "object" ||
    Array.isArray(bugs) ||
    (bugs as Record<string, unknown>).url !== PACKAGE_BUGS_URL
  ) {
    throw new Error("Packed package.json bugs URL is missing or unexpected");
  }

  const publishConfig = pkg.publishConfig;
  if (
    !publishConfig ||
    typeof publishConfig !== "object" ||
    Array.isArray(publishConfig) ||
    (publishConfig as Record<string, unknown>).provenance !== true
  ) {
    throw new Error("Packed package.json publishConfig.provenance must be true");
  }
}

function assertFileList(stdout: string): void {
  const files = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const actual = new Set(files);
  for (const file of expectedFiles) {
    if (!actual.has(file)) {
      throw new Error(`Packed tarball is missing ${file}`);
    }
  }

  const unexpected = files.filter((file) => !expectedFiles.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Packed tarball contains unexpected files: ${unexpected.join(", ")}`);
  }
}

function assertExecutableEntrypoint(stdout: string): void {
  const entryLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(" package/dist/index.js"));

  if (!entryLine) {
    throw new Error("Packed tarball listing is missing package/dist/index.js metadata");
  }

  const mode = entryLine.split(/\s+/, 1)[0];
  if (
    !mode ||
    !/^-[rwx-]{9}$/.test(mode) ||
    mode[3] !== "x" ||
    mode[6] !== "x" ||
    mode[9] !== "x"
  ) {
    throw new Error("Packed dist/index.js must be executable");
  }
}

function parsePackResults(stdout: string): PackResult[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`npm pack did not print JSON output:\n${stdout.trimEnd()}`);
  }

  return JSON.parse(stdout.slice(start, end + 1)) as PackResult[];
}

const packDir = mkdtempSync(join(tmpdir(), "bullmq-dash-pack-"));

try {
  const sourceManifest = JSON.parse(readFileSync("package.json", "utf-8")) as Record<
    string,
    unknown
  >;
  assertSourceManifest(sourceManifest);
  console.log(
    "Source manifest policy: version, metadata, scripts, release gate, exact dependencies, and no graph rewrites verified",
  );

  const lockfileViolations = getLockfilePolicyViolations({
    packageJson: JSON.stringify(sourceManifest),
    rootFiles: readdirSync("."),
    workflowFiles: {
      ".github/workflows/ci.yml": readFileSync(".github/workflows/ci.yml", "utf-8"),
      ".github/workflows/publish.yml": readFileSync(".github/workflows/publish.yml", "utf-8"),
    },
    trackedFiles: await getTrackedFiles(),
  });
  if (lockfileViolations.length > 0) {
    const violation = lockfileViolations[0];
    const location =
      violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`;
    throw new Error(`${location}: ${violation.message}`);
  }
  console.log("Lockfile policy: Bun package manager, tracked lockfile, and frozen CI installs");

  assertRuntimeSourcePolicy();
  console.log(
    `Runtime source policy: no direct ${REMOVED_DIRECT_DEPENDENCIES.join("/")} imports and no dynamic code or shell primitives in src`,
  );

  const { stdout } = await run("npm", [
    "pack",
    "--json",
    "--pack-destination",
    packDir,
    "--cache",
    join(packDir, "npm-cache"),
  ]);
  const packResults = parsePackResults(stdout);
  const packResult = packResults[0];
  if (!packResult) {
    throw new Error("npm pack did not report a tarball result");
  }

  assertPackMetadataPolicy(packResult);
  console.log(`Packed metadata policy: ${formatPackMetadata(packResult)}`);
  if (typeof packResult.integrity !== "string" || !packResult.integrity.startsWith("sha512-")) {
    throw new Error("npm pack must report a SHA512 tarball integrity");
  }
  console.log(`Packed integrity: ${packResult.integrity}`);

  const filename = packResult.filename;
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new Error("npm pack did not report a tarball filename");
  }

  const tarballPath = join(packDir, filename);
  const { stdout: tarList } = await run("tar", ["-tf", tarballPath]);
  assertFileList(tarList);

  const { stdout: tarMetadata } = await run("tar", ["-tvf", tarballPath]);
  assertExecutableEntrypoint(tarMetadata);

  const { stdout: entrypoint } = await run("tar", ["-xOf", tarballPath, "package/dist/index.js"]);
  const { stdout: readme } = await run("tar", ["-xOf", tarballPath, "package/README.md"]);
  assertNoCredentialedRedisUrls({
    "package/README.md": readme,
    "package/dist/index.js": entrypoint,
  });
  console.log("Packed text policy: no credentialed Redis URL examples in README or entrypoint");

  if (!entrypoint.startsWith("#!/usr/bin/env bun\n")) {
    throw new Error("Packed dist/index.js must start with the Bun shebang");
  }

  assertNoRemovedDependencyReferences(entrypoint, "Packed dist/index.js");
  assertPackedEntrypointPolicy(entrypoint);
  console.log("Packed entrypoint policy: no direct ioredis/zod imports in dist/index.js");
  console.log(
    "Packed entrypoint runtime policy: no dynamic code or shell primitives in dist/index.js",
  );

  const { stdout: manifestJson } = await run("tar", ["-xOf", tarballPath, "package/package.json"]);
  const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  assertNoForbiddenPackedManifestFields(manifest);
  console.log(`Packed manifest policy: ${PACKED_MANIFEST_POLICY_MESSAGE}`);
  assertDependencies(manifest);
  assertPackageMetadata(manifest);

  if (sourceManifest.version !== manifest.version) {
    throw new Error("Packed package.json version does not match source package.json");
  }
  console.log(`Packed package version: ${String(manifest.version)}`);
  console.log(`Packed dependency specs: ${getDependencySpecs(manifest).join(", ") || "none"}`);

  const extractDir = join(packDir, "extract");
  mkdirSync(extractDir);
  await run("tar", ["-xzf", tarballPath, "-C", extractDir]);

  console.log(`Verified ${filename}`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
