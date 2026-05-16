import { readFileSync } from "node:fs";

export interface SourceControlPolicyViolation {
  message: string;
}

const requiredGitignoreEntries = [
  "dist/",
  ".env",
  ".env.*",
  ".envrc",
  ".npmrc",
  ".package.json.prepack-backup",
  "*.tgz",
];

function isForbiddenTrackedPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? path;

  // `parts.includes(X)` already covers both "X is the file at any depth"
  // and "X is a directory segment", so no separate `name === X` check is
  // needed for these literal names.
  if (parts.includes("dist")) return true;
  if (parts.includes(".env")) return true;
  if (parts.includes(".envrc")) return true;
  if (parts.includes(".npmrc")) return true;
  if (parts.includes(".package.json.prepack-backup")) return true;
  if (path.endsWith(".tgz")) return true;
  // `.env.<anything>` except a few documented suffixes (e.g. `.env.example`)
  // — the parts-includes check above only matches the exact `.env` name.
  if (name.startsWith(".env.") && !/\.(?:example|sample|template)$/.test(name)) return true;
  return false;
}

export function getSourceControlPolicyViolations(input: {
  gitignore: string;
  trackedFiles: string[];
}): SourceControlPolicyViolation[] {
  const violations: SourceControlPolicyViolation[] = [];
  const gitignoreLines = new Set(
    input.gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );

  for (const entry of requiredGitignoreEntries) {
    if (!gitignoreLines.has(entry)) {
      violations.push({ message: `.gitignore must include ${entry}` });
    }
  }

  for (const file of input.trackedFiles) {
    if (isForbiddenTrackedPath(file)) {
      violations.push({ message: `Forbidden local-only file must not be tracked: ${file}` });
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

if (import.meta.main) {
  const violations = getSourceControlPolicyViolations({
    gitignore: readFileSync(".gitignore", "utf-8"),
    trackedFiles: await getTrackedFiles(),
  });

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation.message);
    }
    process.exit(1);
  }

  console.log("Source control policy: forbidden local-only files ignored and not tracked");
}
