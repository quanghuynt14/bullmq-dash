import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOCKET_CLI_VERSION } from "./audit-socket-target.js";
import {
  getExecutableCommandText,
  getExecutableCommands,
  splitShellSegments,
} from "./workflow-yaml.js";

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

      // Catch `pull_request_target:` (block-key form) and `- pull_request_target`
      // (block-sequence form). The inline-array form `on: [pull_request_target]`
      // is caught by the second regex below — it isn't anchored to start-of-line
      // so it covers `on: pull_request_target` and `on: [push, pull_request_target]`.
      if (
        /^\s*(?:-\s*)?pull_request_target\b/.test(line) ||
        /^\s*on:\s*.*\bpull_request_target\b/.test(line)
      ) {
        violations.push({
          path,
          line: lineNumber,
          message: "pull_request_target is not allowed in release or CI workflows",
        });
      }

      // GHA contexts are case-insensitive and tolerate ${{github.event.…}}
      // (no inner whitespace), so match both forms.
      if (/\$\{\{\s*github\.event\b/i.test(line)) {
        violations.push({
          path,
          line: lineNumber,
          message: "github.event context must not be interpolated into workflow commands",
        });
      }

      if (/\$\{\{\s*secrets\./i.test(line) && !isAllowedSecretEnvLine(path, line)) {
        violations.push({
          path,
          line: lineNumber,
          message: "secrets must only be passed through approved publish step env entries",
        });
      }

      // `npm_config_ignore_scripts` env-var globally suppresses prepack /
      // postpack / prepublishOnly during `npm publish`, so it is banned
      // outright in publish.yml regardless of context (run command or env
      // block). The matching `--ignore-scripts` *flag* is handled below
      // with command-level analysis so we can allow it on `bun install`
      // (where it blocks transitive postinstall) while still rejecting it
      // on `npm publish` (where it would suppress our own prepack).
      if (
        path === ".github/workflows/publish.yml" &&
        !line.trim().startsWith("#") &&
        /\bnpm_config_ignore_scripts\b/i.test(line)
      ) {
        violations.push({
          path,
          line: lineNumber,
          message: "publish workflow must not disable npm lifecycle scripts",
        });
      }
    }

    violations.push(...getCommandLevelIgnoreScriptsViolations(path, content));
  }

  violations.push(...getWorkflowReleasePolicyViolations(files));

  return violations;
}

// Two structural checks (instead of the old blanket `\bignore-scripts\b`
// regex):
//
// 1. `npm publish --ignore-scripts` is banned. The publish workflow's
//    prepack writes the stripped manifest; suppressing it would publish
//    the source manifest as-is and break the policy.
// 2. In publish.yml, every `bun install` invocation must include
//    `--ignore-scripts`. The publish job carries `id-token: write` and
//    NPM_TOKEN, so a transitive postinstall would run with the privileges
//    to mint a provenance attestation. The project's own build runs
//    explicitly via prepack (`await import("../build.ts")`), so install-
//    time lifecycle scripts are unnecessary here.
function getCommandLevelIgnoreScriptsViolations(
  path: string,
  content: string,
): WorkflowPolicyViolation[] {
  const violations: WorkflowPolicyViolation[] = [];
  if (path !== ".github/workflows/publish.yml") return violations;

  for (const { line, command } of getExecutableCommands(content)) {
    for (const segment of splitShellSegments(command)) {
      // Any `npm` command that touches ignore-scripts in the publish job
      // suppresses prepack / postpack / prepublishOnly — either inline
      // (`npm publish --ignore-scripts`), through config (`npm config set
      // ignore-scripts true`), or by setting an alias. Bun's install flag
      // is explicitly excluded by the leading-`npm` anchor below.
      if (/^npm\b/.test(segment) && /\bignore-scripts\b/i.test(segment)) {
        violations.push({
          path,
          line,
          message: "publish workflow must not disable npm lifecycle scripts",
        });
      }

      if (/^bun install\b/.test(segment) && !/\s--ignore-scripts\b/.test(segment)) {
        violations.push({
          path,
          line,
          message:
            "publish workflow must run bun install with --ignore-scripts to block transitive postinstall scripts",
        });
      }
    }
  }
  return violations;
}

function isAllowedSecretEnvLine(path: string, line: string): boolean {
  if (path !== ".github/workflows/publish.yml") {
    return false;
  }

  // Indent only has to be deeper than a top-level key (≥4 spaces); the exact
  // depth depends on how the publish step is nested. Hardcoding 10 spaces
  // would silently break the policy on a YAML restructure.
  return (
    /^\s{4,}NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}\s*$/.test(line) ||
    /^\s{4,}SOCKET_CLI_API_TOKEN:\s*\$\{\{\s*secrets\.SOCKET_CLI_API_TOKEN\s*\}\}\s*$/.test(line)
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

// `npm publish` with provenance can be written several semantically
// equivalent ways: `npm publish --provenance --access public`,
// `npm publish --access public --provenance`, with extra whitespace, or
// with additional flags. Match structurally on the command shape rather
// than a fixed arg order so a future reformat doesn't appear to remove
// provenance.
function findPublishWithProvenanceLine(content: string): number {
  for (const { line, command } of getExecutableCommands(content)) {
    if (!/^npm publish\b/.test(command)) continue;
    if (!/\s--provenance\b/.test(command)) continue;
    if (!/\s--access\s+public\b/.test(command)) continue;
    return line;
  }
  return 0;
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
    // Treat a missing publish workflow as a policy violation rather than
    // silently passing. The publish surface is the most security-sensitive
    // path in the repo — if it's not on disk, the rest of these checks
    // cannot run, and a "deleted by accident" publish workflow would not
    // be caught by any other gate.
    violations.push({
      path: publishPath,
      line: 1,
      message: "publish workflow must exist (.github/workflows/publish.yml)",
    });
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

  const publishCommandLine = findPublishWithProvenanceLine(publish);
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
