import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOCKET_CLI_VERSION } from "./audit-socket-target.js";

export interface WorkflowPolicyViolation {
  path: string;
  line: number;
  message: string;
}

export function getWorkflowPolicyViolations(
  files: Record<string, string>,
): WorkflowPolicyViolation[] {
  const violations: WorkflowPolicyViolation[] = [];

  for (const [path, content] of Object.entries(files)) {
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      const usesMatch = line.match(/^\s*(?:-\s*)?uses:\s*([^@\s#]+)@([^\s#]+)/);
      if (usesMatch) {
        const action = usesMatch[1] ?? "unknown";
        const ref = usesMatch[2] ?? "";
        if (!/^[a-f0-9]{40}$/i.test(ref)) {
          violations.push({
            path,
            line: lineNumber,
            message: `${action}@${ref} must be pinned to a 40-character commit SHA`,
          });
        }
      }

      if (/^\s*(?:-\s*)?pull_request_target\s*:?\s*$/.test(line)) {
        violations.push({
          path,
          line: lineNumber,
          message: "pull_request_target is not allowed in release or CI workflows",
        });
      }

      if (line.includes("${{ github.event.")) {
        violations.push({
          path,
          line: lineNumber,
          message: "github.event context must not be interpolated into workflow commands",
        });
      }

      if (line.includes("${{ secrets.") && !isAllowedSecretEnvLine(path, line)) {
        violations.push({
          path,
          line: lineNumber,
          message: "secrets must only be passed through approved publish step env entries",
        });
      }

      if (
        path === ".github/workflows/publish.yml" &&
        !line.trim().startsWith("#") &&
        (/\bignore-scripts\b/i.test(line) || /\bnpm_config_ignore_scripts\b/i.test(line))
      ) {
        violations.push({
          path,
          line: lineNumber,
          message: "publish workflow must not disable npm lifecycle scripts",
        });
      }
    }
  }

  violations.push(...getWorkflowReleasePolicyViolations(files));

  return violations;
}

function isAllowedSecretEnvLine(path: string, line: string): boolean {
  if (path !== ".github/workflows/publish.yml") {
    return false;
  }

  return (
    /^\s{10}NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}\s*$/.test(line) ||
    /^\s{10}SOCKET_CLI_API_TOKEN:\s*\$\{\{\s*secrets\.SOCKET_CLI_API_TOKEN\s*\}\}\s*$/.test(line)
  );
}

function findLine(content: string, pattern: RegExp): number {
  return findOptionalLine(content, pattern) || 1;
}

function findOptionalLine(content: string, pattern: RegExp): number {
  const index = content.split("\n").findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : 0;
}

function hasTopLevelKey(content: string, key: string): boolean {
  const pattern = new RegExp(`^${key}:\\s*(?:$|#)`, "m");
  return pattern.test(content);
}

function hasTopLevelTrigger(content: string, trigger: string): boolean {
  const pattern = new RegExp(`^\\s{2}${trigger}:\\s*(?:$|#)`, "m");
  return pattern.test(content);
}

function hasPermission(content: string, permission: string, access: string): boolean {
  const pattern = new RegExp(`^\\s{2}${permission}:\\s*${access}\\s*$`, "m");
  return pattern.test(content);
}

function hasDangerousWritePermission(content: string): boolean {
  return /^\s{2}(actions|checks|contents|deployments|issues|packages|pull-requests|statuses):\s*write\s*$/m.test(
    content,
  );
}

function hasLockfilePolicyStep(content: string): boolean {
  return /^\s*(?:-\s*)?run:\s*bun run security:verify-lockfile\s*$/m.test(content);
}

function hasSourceControlPolicyStep(content: string): boolean {
  return findExecutableCommandLine(content, /\bbun run security:verify-source-control\b/) > 0;
}

function hasWorkflowPolicyStep(content: string): boolean {
  return findExecutableCommandLine(content, /\bbun run security:verify-workflows\b/) > 0;
}

function hasPackageVerifierStep(content: string): boolean {
  return findExecutableCommandLine(content, /\bbun run security:verify-package\b/) > 0;
}

function getExecutableCommandText(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return null;
  }

  const runMatch = trimmed.match(/^(?:-\s*)?run:\s*(.*)$/);
  if (runMatch) {
    const command = (runMatch[1] ?? "").trim();
    if (/^[|>]/.test(command)) {
      return null;
    }
    return command;
  }

  if (/^(?:-\s*)?[A-Za-z0-9_-]+:\s*/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function findExecutableCommandLine(content: string, pattern: RegExp, afterLine = 0): number {
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (lineNumber <= afterLine) continue;

    const command = getExecutableCommandText(line);
    if (!command) continue;
    if (/^echo\b/.test(command)) continue;
    if (pattern.test(command)) return lineNumber;
  }

  return 0;
}

function findExecutableCommandMatches(
  content: string,
  pattern: RegExp,
): Array<{ line: number; command: string }> {
  const matches: Array<{ line: number; command: string }> = [];
  const lines = content.split("\n");

  for (const [index, line] of lines.entries()) {
    const command = getExecutableCommandText(line);
    if (!command) continue;
    if (/^echo\b/.test(command)) continue;
    if (pattern.test(command)) {
      matches.push({ line: index + 1, command });
    }
  }

  return matches;
}

function getExpectedSocketCliInstallPattern(): RegExp {
  return new RegExp(
    `^npm install --global @socketsecurity\\/cli@${SOCKET_CLI_VERSION.replaceAll(".", "\\.")}\\s*$`,
  );
}

export function getPinnedSocketCliVersion(publishWorkflow: string): string | null {
  const install = findExecutableCommandMatches(
    publishWorkflow,
    /^npm install --global @socketsecurity\/cli@\d+\.\d+\.\d+\s*$/,
  )[0];
  return install?.command.match(/@socketsecurity\/cli@(\d+\.\d+\.\d+)\s*$/)?.[1] ?? null;
}

function getWorkflowReleasePolicyViolations(
  files: Record<string, string>,
): WorkflowPolicyViolation[] {
  const violations: WorkflowPolicyViolation[] = [];
  const ciPath = ".github/workflows/ci.yml";
  const publishPath = ".github/workflows/publish.yml";
  const ci = files[ciPath];
  const publish = files[publishPath];

  if (ci && !hasPermission(ci, "contents", "read")) {
    violations.push({
      path: ciPath,
      line: findLine(ci, /^\s*permissions:/),
      message: "CI workflow must set permissions.contents to read",
    });
  }

  if (ci && hasDangerousWritePermission(ci)) {
    violations.push({
      path: ciPath,
      line: findLine(
        ci,
        /^\s{2}(actions|checks|contents|deployments|issues|packages|pull-requests|statuses):\s*write\s*$/,
      ),
      message: "CI workflow must not request write permissions",
    });
  }

  if (ci && !hasLockfilePolicyStep(ci)) {
    violations.push({
      path: ciPath,
      line: findLine(ci, /^\s*steps:|security:verify-workflows|security:verify-package|bun test/),
      message: "CI workflow must run the lockfile policy verifier",
    });
  }

  if (ci && !hasSourceControlPolicyStep(ci)) {
    violations.push({
      path: ciPath,
      line: findLine(ci, /^\s*steps:|security:verify-workflows|security:verify-package|bun test/),
      message: "CI workflow must run the source-control policy verifier",
    });
  }

  if (ci && !hasWorkflowPolicyStep(ci)) {
    violations.push({
      path: ciPath,
      line: findLine(ci, /^\s*steps:|security:verify-workflows|security:verify-package|bun test/),
      message: "CI workflow must run the workflow policy verifier",
    });
  }

  if (ci && !hasPackageVerifierStep(ci)) {
    violations.push({
      path: ciPath,
      line: findLine(ci, /^\s*steps:|security:verify-workflows|security:verify-package|bun test/),
      message: "CI workflow must run the package policy verifier",
    });
  }

  if (!publish) {
    return violations;
  }

  if (!hasTopLevelKey(publish, "on") || !hasTopLevelTrigger(publish, "release")) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /^on:/),
      message: "publish workflow must be triggered only by GitHub releases",
    });
  }

  for (const trigger of ["push", "pull_request", "workflow_dispatch"]) {
    if (hasTopLevelTrigger(publish, trigger)) {
      violations.push({
        path: publishPath,
        line: findLine(publish, new RegExp(`^\\s{2}${trigger}:`)),
        message: `publish workflow must not be triggered by ${trigger}`,
      });
    }
  }

  if (!/^\s{4}types:\s*\[published\]\s*$/m.test(publish)) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /^\s*release:/),
      message: "publish workflow release trigger must be limited to published releases",
    });
  }

  if (!hasPermission(publish, "contents", "read")) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /^\s*permissions:/),
      message: "publish workflow must set permissions.contents to read",
    });
  }

  if (!hasPermission(publish, "id-token", "write")) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /^\s*permissions:/),
      message: "publish workflow must set permissions.id-token to write for npm provenance",
    });
  }

  if (/^\s{2}contents:\s*write\s*$/m.test(publish)) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /^\s{2}contents:\s*write\s*$/),
      message: "publish workflow must not request contents write permission",
    });
  }

  const publishCommandLine = findExecutableCommandLine(
    publish,
    /^npm publish --provenance --access public\s*$/,
  );
  const sourceControlVerifierLine = findExecutableCommandLine(
    publish,
    /\bbun run security:verify-source-control\b/,
  );
  const lockfileVerifierLine = findExecutableCommandLine(
    publish,
    /\bbun run security:verify-lockfile\b/,
  );
  const workflowVerifierLine = findExecutableCommandLine(
    publish,
    /\bbun run security:verify-workflows\b/,
  );
  const packageVerifierLine = findExecutableCommandLine(
    publish,
    /\bbun run security:verify-package\b/,
  );
  const scoreCommandLine = findExecutableCommandLine(
    publish,
    /\bbun run security:score\b/,
    publishCommandLine,
  );
  const socketCliInstallLine = findExecutableCommandLine(
    publish,
    getExpectedSocketCliInstallPattern(),
  );
  const mutableSocketCliInstall = findExecutableCommandMatches(
    publish,
    /\bnpm (?:install|i|add)\b.*@socketsecurity\/cli(?:@|\s|$)/,
  ).find(({ command }) => !getExpectedSocketCliInstallPattern().test(command));

  if (publishCommandLine === 0) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /npm publish/),
      message: "publish workflow must publish with npm provenance enabled",
    });
  }

  if (
    lockfileVerifierLine === 0 ||
    (publishCommandLine > 0 && lockfileVerifierLine > publishCommandLine)
  ) {
    violations.push({
      path: publishPath,
      line:
        findOptionalLine(publish, /security:verify-lockfile/) || findLine(publish, /npm publish/),
      message: "publish workflow must run the lockfile policy verifier before publishing",
    });
  }

  if (
    sourceControlVerifierLine === 0 ||
    (publishCommandLine > 0 && sourceControlVerifierLine > publishCommandLine)
  ) {
    violations.push({
      path: publishPath,
      line:
        findOptionalLine(publish, /security:verify-source-control/) ||
        findLine(publish, /npm publish/),
      message: "publish workflow must run the source-control policy verifier before publishing",
    });
  }

  if (
    workflowVerifierLine === 0 ||
    (publishCommandLine > 0 && workflowVerifierLine > publishCommandLine)
  ) {
    violations.push({
      path: publishPath,
      line:
        findOptionalLine(publish, /security:verify-workflows/) || findLine(publish, /npm publish/),
      message: "publish workflow must run the workflow policy verifier before publishing",
    });
  }

  if (
    packageVerifierLine === 0 ||
    (publishCommandLine > 0 && packageVerifierLine > publishCommandLine)
  ) {
    violations.push({
      path: publishPath,
      line:
        findOptionalLine(publish, /security:verify-package/) || findLine(publish, /npm publish/),
      message: "publish workflow must run the package policy verifier before publishing",
    });
  }

  if (publishCommandLine > 0 && scoreCommandLine === 0) {
    violations.push({
      path: publishPath,
      line: findLine(publish, /security:score|npm publish/),
      message: "publish workflow must score the just-published package with Socket",
    });
  }

  if (mutableSocketCliInstall) {
    violations.push({
      path: publishPath,
      line: mutableSocketCliInstall.line,
      message: `publish workflow must install Socket CLI ${SOCKET_CLI_VERSION} after publishing and before scoring`,
    });
  }

  if (
    !mutableSocketCliInstall &&
    scoreCommandLine > 0 &&
    (socketCliInstallLine === 0 ||
      socketCliInstallLine < publishCommandLine ||
      socketCliInstallLine > scoreCommandLine)
  ) {
    violations.push({
      path: publishPath,
      line:
        findOptionalLine(publish, /@socketsecurity\/cli/) ||
        findLine(publish, /security:score|npm publish/),
      message: `publish workflow must install Socket CLI ${SOCKET_CLI_VERSION} after publishing and before scoring`,
    });
  }

  return violations;
}

function readWorkflowFiles(): Record<string, string> {
  const workflowsDir = ".github/workflows";
  const files: Record<string, string> = {};

  for (const name of readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const path = join(workflowsDir, name);
    files[path] = readFileSync(path, "utf-8");
  }

  return files;
}

if (import.meta.main) {
  const workflowFiles = readWorkflowFiles();
  const violations = getWorkflowPolicyViolations(workflowFiles);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.path}:${violation.line}: ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Workflow policy: actions pinned by SHA, unsafe PR/event patterns absent, source-control, lockfile, workflow, and package verifier steps run before publishing, secrets scoped, release publishing locked down, npm lifecycle scripts enabled, exact Socket CLI install pinned${getPinnedSocketCliVersion(workflowFiles[".github/workflows/publish.yml"] ?? "") ? ` to ${getPinnedSocketCliVersion(workflowFiles[".github/workflows/publish.yml"] ?? "")}` : ""}, and post-publish Socket scoring enforced`,
  );
}
