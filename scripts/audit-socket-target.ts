import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TARGET_PACKAGE = "bullmq-dash@0.2.7";
export const COMMAND_TIMEOUT_MS = 30_000;
export const SOCKET_CLI_VERSION = "1.1.94";
export const SOCKET_CLI_PACKAGE = `@socketsecurity/cli@${SOCKET_CLI_VERSION}`;
export const REMOVED_TARGET_DEPENDENCIES = ["ioredis", "zod"] as const;

export interface NpmView {
  name?: unknown;
  version?: unknown;
  versions?: unknown;
  deprecated?: unknown;
  dependencies?: unknown;
  time?: unknown;
  dist?: {
    integrity?: unknown;
    tarball?: unknown;
  };
}

export interface SocketAlert {
  name?: unknown;
  severity?: unknown;
  example?: unknown;
}

export interface SocketScore {
  ok?: unknown;
  data?: {
    purl?: unknown;
    self?: {
      alerts?: SocketAlert[];
    };
    transitively?: {
      dependencyCount?: unknown;
      alerts?: SocketAlert[];
    };
  };
}

export interface AuditSummary {
  targetPackage: string;
  socketCliVersion: string;
  socketOk: boolean;
  socketPurl: string;
  publishedName: string;
  expectedName: string;
  publishedVersion: string;
  expectedVersion: string;
  deprecated: boolean;
  deprecationMessage: string;
  registryVersionCount: number;
  targetVersionListed: boolean;
  publishedAt: string;
  tarballIntegrity: string;
  tarballUrl: string;
  tarballManifestName: string;
  tarballManifestVersion: string;
  tarballManifestDependencySpecs: string[];
  dependencyCount: string;
  directDependencies: string[];
  directDependencySpecs: string[];
  alertCount: number;
  selfAlertCount: number;
  transitiveAlertCount: number;
  severityCounts: Record<string, number>;
  alertNameCounts: Record<string, number>;
  selfAlertNameCounts: Record<string, number>;
  transitiveAlertNameCounts: Record<string, number>;
  topAlerts: string[];
  immutableDependencyFindings: string[];
  targetMismatch: boolean;
  nameMismatch: boolean;
  versionMismatch: boolean;
  registryVersionMissing: boolean;
  tarballUrlMismatch: boolean;
  tarballManifestMismatch: boolean;
  tarballManifestDependencyFindings: string[];
  clean: boolean;
}

async function run(
  command: string,
  args: string[],
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));

  if (timedOut) {
    throw new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
  }

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${stderr.trimEnd()}`);
  }

  return { stdout, stderr };
}

export function runPinnedSocket(
  args: string[],
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return run(
    "npm",
    ["exec", "--yes", "--package", SOCKET_CLI_PACKAGE, "--", "socket", ...args],
    timeoutMs,
  );
}

export function parseJsonFromNoisyOutput<T>(stdout: string): T {
  const objectStart = stdout.indexOf("{");
  const arrayStart = stdout.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  const end = Math.max(stdout.lastIndexOf("}"), stdout.lastIndexOf("]"));
  if (start < 0 || end < start) {
    throw new Error(`Expected JSON value in command output:\n${stdout.trimEnd()}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

export function formatAlert(alert: SocketAlert): string {
  return `${String(alert.severity)} ${String(alert.name)} (${String(alert.example)})`;
}

function getSeverityCounts(alerts: SocketAlert[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const alert of alerts) {
    const severity = String(alert.severity ?? "unknown");
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

function getAlertNameCounts(alerts: SocketAlert[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const alert of alerts) {
    const name = String(alert.name ?? "unknown");
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function formatSeverityCounts(counts: Record<string, number>): string {
  const ordered = ["critical", "high", "middle", "low", "unknown"];
  const parts = ordered
    .filter((severity) => counts[severity])
    .map((severity) => `${severity}=${counts[severity]}`);
  const remaining = Object.keys(counts)
    .filter((severity) => !ordered.includes(severity))
    .toSorted()
    .map((severity) => `${severity}=${counts[severity]}`);

  return [...parts, ...remaining].join(", ") || "none";
}

function formatNameCounts(counts: Record<string, number>): string {
  return (
    Object.keys(counts)
      .toSorted()
      .map((name) => `${name}=${counts[name]}`)
      .join(", ") || "none"
  );
}

function getDependencyMap(npmView: NpmView): Record<string, unknown> {
  return npmView.dependencies &&
    typeof npmView.dependencies === "object" &&
    !Array.isArray(npmView.dependencies)
    ? (npmView.dependencies as Record<string, unknown>)
    : {};
}

function getPublishedAt(npmView: NpmView, version: string): string {
  const time = npmView.time;
  if (!time || typeof time !== "object" || Array.isArray(time)) return "unknown";
  const publishedAt = (time as Record<string, unknown>)[version];
  return typeof publishedAt === "string" ? publishedAt : "unknown";
}

function getExpectedVersion(targetPackage: string): string {
  const version = targetPackage.split("@").at(-1);
  return version && version !== targetPackage ? version : "unknown";
}

function getExpectedName(targetPackage: string): string {
  const atIndex = targetPackage.lastIndexOf("@");
  return atIndex > 0 ? targetPackage.slice(0, atIndex) : targetPackage;
}

function getRegistryVersions(npmView: NpmView): string[] {
  return Array.isArray(npmView.versions)
    ? npmView.versions.filter((version): version is string => typeof version === "string")
    : [];
}

function getExpectedTarballUrl(targetPackage: string): string {
  const [name, version] = targetPackage.split("@");
  if (!name || !version) return "unknown";
  return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
}

export function buildAuditSummary(
  npmView: NpmView,
  socketScore: SocketScore,
  targetPackage: string = TARGET_PACKAGE,
  socketCliVersion: string = "unknown",
  tarballManifest: NpmView = npmView,
): AuditSummary {
  const dependencies = getDependencyMap(npmView);
  const tarballDependencies = getDependencyMap(tarballManifest);
  const selfAlerts = socketScore.data?.self?.alerts ?? [];
  const transitiveAlerts = socketScore.data?.transitively?.alerts ?? [];
  const allAlerts = [...selfAlerts, ...transitiveAlerts];
  const immutableDependencyFindings = REMOVED_TARGET_DEPENDENCIES.filter(
    (dependency) => dependency in dependencies,
  );
  const tarballManifestDependencyFindings = REMOVED_TARGET_DEPENDENCIES.filter(
    (dependency) => dependency in tarballDependencies,
  );
  const socketPurl = String(socketScore.data?.purl);
  const socketOk = socketScore.ok === true;
  const expectedPurl = `pkg:npm/${targetPackage}`;
  const targetMismatch = socketPurl !== expectedPurl;
  const publishedName = String(npmView.name);
  const expectedName = getExpectedName(targetPackage);
  const nameMismatch = publishedName !== expectedName;
  const publishedVersion = String(npmView.version);
  const expectedVersion = getExpectedVersion(targetPackage);
  const versionMismatch = publishedVersion !== expectedVersion;
  const deprecated = typeof npmView.deprecated === "string" && npmView.deprecated.trim() !== "";
  const registryVersions = getRegistryVersions(npmView);
  const targetVersionListed = registryVersions.includes(expectedVersion);
  const registryVersionMissing = !targetVersionListed;
  const tarballUrl = typeof npmView.dist?.tarball === "string" ? npmView.dist.tarball : "unknown";
  const expectedTarballUrl = getExpectedTarballUrl(targetPackage);
  const tarballUrlMismatch = tarballUrl !== expectedTarballUrl;
  const tarballManifestName = String(tarballManifest.name);
  const tarballManifestVersion = String(tarballManifest.version);
  const tarballManifestMismatch =
    tarballManifestName !== expectedName || tarballManifestVersion !== expectedVersion;

  return {
    targetPackage,
    socketCliVersion,
    socketOk,
    socketPurl,
    publishedName,
    expectedName,
    publishedVersion,
    expectedVersion,
    deprecated,
    deprecationMessage: deprecated ? String(npmView.deprecated) : "none",
    registryVersionCount: registryVersions.length,
    targetVersionListed,
    publishedAt: getPublishedAt(npmView, publishedVersion),
    tarballIntegrity:
      typeof npmView.dist?.integrity === "string" ? npmView.dist.integrity : "unknown",
    tarballUrl,
    tarballManifestName,
    tarballManifestVersion,
    tarballManifestDependencySpecs: Object.entries(tarballDependencies).map(([name, version]) => {
      return `${name}@${String(version)}`;
    }),
    dependencyCount: String(socketScore.data?.transitively?.dependencyCount),
    directDependencies: Object.keys(dependencies),
    directDependencySpecs: Object.entries(dependencies).map(([name, version]) => {
      return `${name}@${String(version)}`;
    }),
    alertCount: allAlerts.length,
    selfAlertCount: selfAlerts.length,
    transitiveAlertCount: transitiveAlerts.length,
    severityCounts: getSeverityCounts(allAlerts),
    alertNameCounts: getAlertNameCounts(allAlerts),
    selfAlertNameCounts: getAlertNameCounts(selfAlerts),
    transitiveAlertNameCounts: getAlertNameCounts(transitiveAlerts),
    topAlerts: allAlerts.slice(0, 10).map(formatAlert),
    immutableDependencyFindings,
    targetMismatch,
    nameMismatch,
    versionMismatch,
    registryVersionMissing,
    tarballUrlMismatch,
    tarballManifestMismatch,
    tarballManifestDependencyFindings,
    clean:
      allAlerts.length === 0 &&
      immutableDependencyFindings.length === 0 &&
      tarballManifestDependencyFindings.length === 0 &&
      socketOk &&
      !targetMismatch &&
      !nameMismatch &&
      !versionMismatch &&
      !registryVersionMissing &&
      !tarballUrlMismatch &&
      !tarballManifestMismatch,
  };
}

export function renderAuditSummary(summary: AuditSummary): {
  stdout: string[];
  stderr: string[];
  exitCode: number;
} {
  const stdout = [
    `Socket target audit: npm/${summary.targetPackage}`,
    `Socket CLI version: ${summary.socketCliVersion}`,
    `Socket ok: ${summary.socketOk}`,
    `Socket purl: ${summary.socketPurl}`,
    `Published name: ${summary.publishedName}`,
    `Published version: ${summary.publishedVersion}`,
    `Deprecated: ${summary.deprecated}`,
    `Deprecation message: ${summary.deprecationMessage}`,
    `Registry version count: ${summary.registryVersionCount}`,
    `Target version listed: ${summary.targetVersionListed}`,
    `Published at: ${summary.publishedAt}`,
    `Tarball integrity: ${summary.tarballIntegrity}`,
    `Tarball URL: ${summary.tarballUrl}`,
    `Registry tarball manifest name: ${summary.tarballManifestName}`,
    `Registry tarball manifest version: ${summary.tarballManifestVersion}`,
    `Registry tarball manifest dependency specs: ${summary.tarballManifestDependencySpecs.join(", ")}`,
    `Published dependency count: ${summary.dependencyCount}`,
    `Direct dependencies: ${summary.directDependencies.join(", ")}`,
    `Direct dependency specs: ${summary.directDependencySpecs.join(", ")}`,
    `Alert count: ${summary.alertCount}`,
    `Package-self alert count: ${summary.selfAlertCount}`,
    `Transitive alert count: ${summary.transitiveAlertCount}`,
    `Alert severities: ${formatSeverityCounts(summary.severityCounts)}`,
    `Alert types: ${formatNameCounts(summary.alertNameCounts)}`,
    `Package-self alert types: ${formatNameCounts(summary.selfAlertNameCounts)}`,
    `Transitive alert types: ${formatNameCounts(summary.transitiveAlertNameCounts)}`,
  ];
  const stderr: string[] = [];

  if (summary.topAlerts.length > 0) {
    stdout.push("Top alerts:");
    for (const alert of summary.topAlerts) {
      stdout.push(`- ${alert}`);
    }
  }

  if (summary.immutableDependencyFindings.length > 0) {
    stdout.push(
      `Immutable target still has removed direct dependencies: ${summary.immutableDependencyFindings.join(", ")}`,
    );
  }

  if (summary.tarballManifestDependencyFindings.length > 0) {
    stdout.push(
      `Registry tarball manifest still has removed direct dependencies: ${summary.tarballManifestDependencyFindings.join(", ")}`,
    );
  }

  if (!summary.socketOk) {
    stdout.push("Socket response not ok");
  }

  if (summary.targetMismatch) {
    stdout.push(
      `Socket target mismatch: expected pkg:npm/${summary.targetPackage}, got ${summary.socketPurl}`,
    );
  }

  if (summary.nameMismatch) {
    stdout.push(
      `Published name mismatch: expected ${summary.expectedName}, got ${summary.publishedName}`,
    );
  }

  if (summary.versionMismatch) {
    stdout.push(
      `Published version mismatch: expected ${summary.expectedVersion}, got ${summary.publishedVersion}`,
    );
  }

  if (summary.registryVersionMissing) {
    stdout.push(`Registry version list does not include ${summary.expectedVersion}`);
  }

  if (summary.tarballUrlMismatch) {
    stdout.push(
      `Tarball URL mismatch: expected ${getExpectedTarballUrl(summary.targetPackage)}, got ${summary.tarballUrl}`,
    );
  }

  if (summary.tarballManifestMismatch) {
    stdout.push(
      `Registry tarball manifest mismatch: expected ${summary.expectedName}@${summary.expectedVersion}, got ${summary.tarballManifestName}@${summary.tarballManifestVersion}`,
    );
  }

  if (!summary.clean) {
    stdout.push(
      `npm/${summary.targetPackage} is not clean. This command scores the already-published registry artifact, not the local worktree.`,
    );
    return { stdout, stderr, exitCode: 1 };
  }

  stdout.push(`npm/${summary.targetPackage} is clean.`);
  return { stdout, stderr, exitCode: 0 };
}

async function fetchPublishedTarballManifest(targetPackage: string): Promise<NpmView> {
  const packDir = mkdtempSync(join(tmpdir(), "bullmq-dash-registry-pack-"));

  try {
    const packOutput = parseJsonFromNoisyOutput<Array<{ filename?: unknown }>>(
      (await run("npm", ["pack", targetPackage, "--json", "--pack-destination", packDir])).stdout,
    );
    const filename = packOutput[0]?.filename;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new Error(`npm pack ${targetPackage} did not report a tarball filename`);
    }

    const tarballPath = join(packDir, filename);
    const { stdout } = await run("tar", ["-xOf", tarballPath, "package/package.json"]);
    return JSON.parse(stdout) as NpmView;
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

async function fetchAuditSummary(): Promise<AuditSummary> {
  const socketVersion = (await runPinnedSocket(["--version"])).stdout.trim() || "unknown";
  const npmView = parseJsonFromNoisyOutput<NpmView>(
    (
      await run("npm", [
        "view",
        TARGET_PACKAGE,
        "name",
        "version",
        "versions",
        "dependencies",
        "deprecated",
        "time",
        "dist",
        "--json",
      ])
    ).stdout,
  );

  const socketScore = parseJsonFromNoisyOutput<SocketScore>(
    (await runPinnedSocket(["package", "score", "npm", TARGET_PACKAGE, "--json"])).stdout,
  );
  const tarballManifest = await fetchPublishedTarballManifest(TARGET_PACKAGE);

  return buildAuditSummary(npmView, socketScore, TARGET_PACKAGE, socketVersion, tarballManifest);
}

async function main(): Promise<void> {
  const summary = await fetchAuditSummary();
  const rendered = renderAuditSummary(summary);

  for (const line of rendered.stdout) {
    console.log(line);
  }
  for (const line of rendered.stderr) {
    console.error(line);
  }

  process.exit(rendered.exitCode);
}

if (import.meta.main) {
  await main();
}
