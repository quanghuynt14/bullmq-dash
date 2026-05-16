import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_PACKAGE_MANAGER } from "./publish-policy.js";
import { getExecutableCommands, splitShellSegments } from "./workflow-yaml.js";

export interface LockfilePolicyInput {
  packageJson: string;
  rootFiles: string[];
  workflowFiles: Record<string, string>;
  trackedFiles: string[];
}

export interface LockfilePolicyViolation {
  path: string;
  line?: number;
  message: string;
}

const requiredWorkflowFiles = [".github/workflows/ci.yml", ".github/workflows/publish.yml"];
const competingLockfiles = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

function getBunInstallSegments(command: string): string[] {
  return splitShellSegments(command).filter((segment) => /^bun install\b/.test(segment));
}

// Frozen-lockfile only requires the flag to be present anywhere in the
// `bun install` invocation — `bun install --production --frozen-lockfile`
// and `bun install --frozen-lockfile --ignore-scripts` both qualify. We
// match `\b--frozen-lockfile\b` rather than anchoring to a fixed position
// so flag reordering doesn't silently demote the install to mutable.
function isFrozenBunInstall(segment: string): boolean {
  if (!/^bun install\b/.test(segment)) return false;
  return /\s--frozen-lockfile\b/.test(segment);
}

function parsePackageJson(packageJson: string): Record<string, unknown> | null {
  try {
    return JSON.parse(packageJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getLockfilePolicyViolations(input: LockfilePolicyInput): LockfilePolicyViolation[] {
  const violations: LockfilePolicyViolation[] = [];
  const rootFiles = new Set(input.rootFiles);
  const trackedFiles = new Set(input.trackedFiles);
  const manifest = parsePackageJson(input.packageJson);

  if (!manifest) {
    violations.push({
      path: "package.json",
      message: "package.json must be valid JSON",
    });
  } else if (manifest.packageManager !== BUN_PACKAGE_MANAGER) {
    violations.push({
      path: "package.json",
      message: `packageManager must be pinned to ${BUN_PACKAGE_MANAGER}`,
    });
  }

  if (!rootFiles.has("bun.lock")) {
    violations.push({
      path: "bun.lock",
      message: "bun.lock must exist",
    });
  }

  if (!trackedFiles.has("bun.lock")) {
    violations.push({
      path: "bun.lock",
      message: "bun.lock must be tracked in git",
    });
  }

  for (const lockfile of competingLockfiles) {
    if (rootFiles.has(lockfile)) {
      violations.push({
        path: lockfile,
        message: `${lockfile} must not exist; Bun is the only supported package manager`,
      });
    }
  }

  for (const path of requiredWorkflowFiles) {
    const content = input.workflowFiles[path];
    if (!content) {
      violations.push({
        path,
        message: `${path} must exist and install dependencies with bun install --frozen-lockfile`,
      });
      continue;
    }

    const executableCommands = getExecutableCommands(content);
    const installCommands = executableCommands
      .map(({ line, command }) => ({
        line,
        segments: getBunInstallSegments(command),
      }))
      .filter(({ segments }) => segments.length > 0);
    const hasFrozenInstall = installCommands.some(({ segments }) =>
      segments.some(isFrozenBunInstall),
    );

    if (!hasFrozenInstall) {
      violations.push({
        path,
        line: installCommands[0]?.line,
        message: "workflow must install dependencies with bun install --frozen-lockfile",
      });
    }

    for (const { line, segments } of installCommands) {
      for (const segment of segments) {
        if (isFrozenBunInstall(segment)) continue;
        violations.push({
          path,
          line,
          message: "workflow must not run bun install without --frozen-lockfile",
        });
      }
    }
  }

  return violations;
}

async function getTrackedFiles(): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ls-files failed:\n${stderr.trimEnd()}`);
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readWorkflowFiles(): Record<string, string> {
  const workflowsDir = ".github/workflows";
  const files: Record<string, string> = {};

  if (!existsSync(workflowsDir)) {
    return files;
  }

  for (const name of readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const path = join(workflowsDir, name);
    files[path] = readFileSync(path, "utf-8");
  }

  return files;
}

async function main(): Promise<void> {
  const violations = getLockfilePolicyViolations({
    packageJson: readFileSync("package.json", "utf-8"),
    rootFiles: readdirSync("."),
    workflowFiles: readWorkflowFiles(),
    trackedFiles: await getTrackedFiles(),
  });

  if (violations.length > 0) {
    for (const violation of violations) {
      const location =
        violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`;
      console.error(`${location}: ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(`Lockfile policy: ${BUN_PACKAGE_MANAGER}, bun.lock tracked, and CI installs frozen`);
}

if (import.meta.main) {
  await main();
}
