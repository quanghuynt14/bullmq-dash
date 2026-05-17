import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOCKET_CLI_VERSION } from "./audit-socket-target.js";
import {
  escapeRegex,
  getExecutableCommandText,
  getExecutableCommands,
  hasBooleanFlagEnabled,
  splitShellSegments,
} from "./workflow-yaml.js";

export interface WorkflowPolicyViolation {
  path: string;
  line: number;
  message: string;
}

interface ParsedStep {
  name?: unknown;
  uses?: unknown;
  run?: unknown;
  env?: unknown;
  with?: unknown;
  id?: unknown;
}

interface ParsedWorkflow {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, { steps?: unknown }>;
}

function parseWorkflowYaml(content: string): ParsedWorkflow | null {
  try {
    const parsed = Bun.YAML.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ParsedWorkflow;
  } catch {
    return null;
  }
}

function collectParsedSteps(parsed: ParsedWorkflow): ParsedStep[] {
  if (!parsed.jobs) return [];
  const steps: ParsedStep[] = [];
  for (const job of Object.values(parsed.jobs)) {
    if (!job || typeof job !== "object" || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (step && typeof step === "object" && !Array.isArray(step)) {
        steps.push(step as ParsedStep);
      }
    }
  }
  return steps;
}

export function getWorkflowPolicyViolations(
  files: Record<string, string>,
): WorkflowPolicyViolation[] {
  const violations: WorkflowPolicyViolation[] = [];

  for (const [path, content] of Object.entries(files)) {
    const lines = content.split("\n");
    const parsed = parseWorkflowYaml(content);

    // Step boundaries: prefer YAML-derived attribution over the regex
    // splitter when both agree on step count. If the splitter sees more
    // anchors than the parser sees steps, something in the workflow
    // (e.g. list-shaped text inside a `run: |` block, a YAML anchor
    // expansion) is creating false step boundaries; refuse to lint
    // secret bindings on that shape rather than silently mis-attribute.
    let steps: WorkflowStep[];
    if (parsed) {
      const yamlBacked = getYamlBackedSteps(content, parsed);
      if (yamlBacked === null) {
        violations.push({
          path,
          line: 1,
          message:
            "workflow step shape is ambiguous (line-splitter anchor count != parsed step count); simplify the YAML so the linter can attribute lines to steps deterministically",
        });
        steps = getWorkflowSteps(content);
      } else {
        steps = yamlBacked;
      }
    } else {
      if (/\$\{\{\s*secrets\./i.test(content)) {
        violations.push({
          path,
          line: 1,
          message: "workflow YAML failed to parse; refuse to lint secret bindings",
        });
      }
      steps = getWorkflowSteps(content);
    }

    // Secrets allow-list derived from the parsed structure: each entry
    // describes an env binding the publish step is permitted to hold,
    // anchored to a specific step's run command. Without this list, the
    // line scan would allow ANY occurrence of `KEY: ${{ secrets.NAME }}`
    // anywhere in the file as long as the literal text matched the
    // approved pattern, even on a step that doesn't actually publish.
    const approvedBindings = parsed ? getApprovedSecretBindings(parsed, path) : [];

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

      if (
        /\$\{\{\s*secrets\./i.test(line) &&
        !isAllowedSecretEnvLine(path, line, findEnclosingStep(steps, lineNumber), approvedBindings)
      ) {
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

// Structural checks (instead of a blanket `\bignore-scripts\b` regex):
//
// 1. `npm publish --ignore-scripts` is banned in publish.yml. The publish
//    workflow's prepack writes the stripped manifest; suppressing it would
//    publish the source manifest as-is and break the policy.
// 2. In **both** CI and publish, every `bun install` invocation must
//    include `--ignore-scripts`. The publish job carries `id-token: write`
//    and NPM_TOKEN, so a transitive postinstall there would run with the
//    privileges to mint a provenance attestation. The CI job runs with
//    `contents: read` and `persist-credentials: false`, but a postinstall
//    can still poison the runner cache or tamper with the working tree
//    before security:verify-package packs it — so the rule applies there
//    too. The project's own build runs explicitly via prepack
//    (`await import("../build.ts")`) and `bun run build`, so install-time
//    lifecycle scripts are unnecessary in either workflow.
function getCommandLevelIgnoreScriptsViolations(
  path: string,
  content: string,
): WorkflowPolicyViolation[] {
  const violations: WorkflowPolicyViolation[] = [];
  const isPublish = path === ".github/workflows/publish.yml";
  const isCi = path === ".github/workflows/ci.yml";
  if (!isPublish && !isCi) return violations;

  for (const { line, command } of getExecutableCommands(content)) {
    for (const segment of splitShellSegments(command)) {
      // Any `npm` command that touches ignore-scripts in the publish job
      // suppresses prepack / postpack / prepublishOnly — either inline
      // (`npm publish --ignore-scripts`), through config (`npm config set
      // ignore-scripts true`), or by setting an alias. Bun's install flag
      // is explicitly excluded by the leading-`npm` anchor below.
      if (isPublish && /^npm\b/.test(segment) && /\bignore-scripts\b/i.test(segment)) {
        violations.push({
          path,
          line,
          message: "publish workflow must not disable npm lifecycle scripts",
        });
      }

      if (/^bun install\b/.test(segment) && !hasBooleanFlagEnabled(segment, "ignore-scripts")) {
        const workflowLabel = isPublish ? "publish" : "CI";
        violations.push({
          path,
          line,
          message: `${workflowLabel} workflow must run bun install with --ignore-scripts to block transitive postinstall scripts`,
        });
      }
    }
  }
  return violations;
}

interface WorkflowStep {
  startLine: number;
  endLine: number;
  content: string;
}

// Split a workflow file into its step blocks. A step starts at any
// hyphen-led list item that introduces a YAML key (`- name:`, `- uses:`,
// `- run:`, `- env:`, etc.) and runs until the next such line or end of
// file. This is the minimum structure we need to ask "does the step
// that owns this env line also run `npm publish`?" without pulling in a
// YAML parser. Header lines (`on:`, `permissions:`, `jobs:`, etc.) that
// precede the first step fall outside any block.
function getWorkflowSteps(content: string): WorkflowStep[] {
  const lines = content.split("\n");
  const steps: WorkflowStep[] = [];
  let currentStart: number | null = null;

  for (const [index, line] of lines.entries()) {
    if (/^\s+-\s+[\w-]+:/.test(line)) {
      if (currentStart !== null) {
        steps.push({
          startLine: currentStart,
          endLine: index,
          content: lines.slice(currentStart - 1, index).join("\n"),
        });
      }
      currentStart = index + 1;
    }
  }
  if (currentStart !== null) {
    steps.push({
      startLine: currentStart,
      endLine: lines.length,
      content: lines.slice(currentStart - 1).join("\n"),
    });
  }
  return steps;
}

function findEnclosingStep(steps: WorkflowStep[], lineNumber: number): WorkflowStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.startLine <= lineNumber && lineNumber <= step.endLine) {
      return step;
    }
  }
  return null;
}

function stepRunMatches(step: WorkflowStep, pattern: RegExp): boolean {
  for (const { command } of getExecutableCommands(step.content)) {
    if (pattern.test(command)) return true;
  }
  return false;
}

interface ApprovedSecretBinding {
  envKey: string;
  secretName: string;
}

// Build the set of step-attributed approved secret bindings by walking
// the YAML-parsed structure. Each entry says "this env key + secret name
// is permitted **because** there exists a step in the parsed workflow
// whose run command matches the approved pattern". The line scan then
// allows a `KEY: ${{ secrets.NAME }}` line only when the KEY+NAME pair
// is on this list — which means a second, copy-pasted env binding on a
// non-publish step is correctly rejected, because no step in the parsed
// structure justifies that binding via its own run command.
function getApprovedSecretBindings(parsed: ParsedWorkflow, path: string): ApprovedSecretBinding[] {
  if (path !== ".github/workflows/publish.yml" || !parsed.jobs) return [];
  const approved: ApprovedSecretBinding[] = [];

  for (const step of collectParsedSteps(parsed)) {
    if (!step.env || typeof step.env !== "object" || Array.isArray(step.env)) continue;
    const run = typeof step.run === "string" ? step.run : "";

    for (const [envKey, envValue] of Object.entries(step.env as Record<string, unknown>)) {
      if (typeof envValue !== "string") continue;
      const secretMatch = envValue.match(
        /^\s*\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/,
      );
      if (!secretMatch) continue;
      const secretName = secretMatch[1] ?? "";

      if (
        envKey === "NODE_AUTH_TOKEN" &&
        secretName === "NPM_TOKEN" &&
        /^npm publish\b/.test(run.trim())
      ) {
        approved.push({ envKey, secretName });
      }
      if (
        envKey === "SOCKET_CLI_API_TOKEN" &&
        secretName === "SOCKET_CLI_API_TOKEN" &&
        (/\bsecurity:score\b/.test(run) || /^socket\b/.test(run.trim()))
      ) {
        approved.push({ envKey, secretName });
      }
    }
  }

  return approved;
}

function isAllowedSecretEnvLine(
  path: string,
  line: string,
  step: WorkflowStep | null,
  approved: ApprovedSecretBinding[],
): boolean {
  if (path !== ".github/workflows/publish.yml") return false;
  if (!step) return false;

  // The line must match one of the approved bindings. We require the
  // pair (envKey, secretName) to appear in `approved`, which is built
  // from the parsed structure — so a free-floating env block that
  // shares a literal env line with the publish step still fails,
  // because that block's parent step has the wrong run command.
  for (const { envKey, secretName } of approved) {
    const pattern = new RegExp(
      `^\\s{4,}${escapeRegex(envKey)}:\\s*\\$\\{\\{\\s*secrets\\.${escapeRegex(secretName)}\\s*\\}\\}\\s*$`,
    );
    if (pattern.test(line)) {
      // Final guard: the line must actually fall inside the same step
      // (per YAML-backed boundaries) that the parsed structure used
      // to justify this binding. The simplest expression is "step.run
      // matches the approved pattern" — same check getApprovedSecretBindings
      // did, but re-applied here so a misattributed line in a non-
      // publish step (with a parsed-elsewhere approval) cannot sneak
      // through.
      if (envKey === "NODE_AUTH_TOKEN") return stepRunMatches(step, /^npm publish\b/);
      if (envKey === "SOCKET_CLI_API_TOKEN") {
        return stepRunMatches(step, /\bsecurity:score\b|^socket\b/);
      }
    }
  }
  return false;
}

// Pair anchor lines (regex-detected step starts) with parsed-step
// indices. Returns null when the counts disagree — that signals YAML
// shapes the line splitter can't parse deterministically (list-shaped
// text inside `run: |` blocks, YAML anchors, etc.) and the caller
// should fall back rather than risk misattribution.
function getYamlBackedSteps(content: string, parsed: ParsedWorkflow): WorkflowStep[] | null {
  const parsedSteps = collectParsedSteps(parsed);
  const lines = content.split("\n");
  const anchorPattern = /^\s{4,}-\s+(?:name|uses|run|id|env|with|if|shell|working-directory):/;
  const anchors: number[] = [];

  for (const [index, line] of lines.entries()) {
    if (anchorPattern.test(line)) anchors.push(index + 1);
  }

  if (parsedSteps.length === 0 && anchors.length === 0) return [];
  if (anchors.length !== parsedSteps.length) return null;

  const steps: WorkflowStep[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const startLine = anchors[i]!;
    const endLine = i + 1 < anchors.length ? anchors[i + 1]! - 1 : lines.length;
    steps.push({
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
    });
  }
  return steps;
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

interface SecurityVerifier {
  script: string;
  label: string;
}

// Source-control → lockfile → workflows → package matches the natural
// pre-publish ordering of the publish workflow. The publish-side check
// requires each to run before `npm publish`, so the order here is the
// order violations surface when multiple are missing.
const SECURITY_VERIFIERS: ReadonlyArray<SecurityVerifier> = [
  { script: "security:verify-source-control", label: "source-control" },
  { script: "security:verify-lockfile", label: "lockfile" },
  { script: "security:verify-workflows", label: "workflow" },
  { script: "security:verify-package", label: "package" },
];

function findVerifierCommandLine(content: string, script: string): number {
  return findExecutableCommandLine(content, new RegExp(`\\bbun run ${escapeRegex(script)}\\b`));
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
    `^npm install --global @socketsecurity\\/cli@${escapeRegex(SOCKET_CLI_VERSION)}\\s*$`,
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

  if (ci) {
    const ciFallbackLine = findLine(
      ci,
      /^\s*steps:|security:verify-workflows|security:verify-package|bun test/,
    );
    for (const { script, label } of SECURITY_VERIFIERS) {
      if (findVerifierCommandLine(ci, script) === 0) {
        violations.push({
          path: ciPath,
          line: ciFallbackLine,
          message: `CI workflow must run the ${label} policy verifier`,
        });
      }
    }
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

  for (const { script, label } of SECURITY_VERIFIERS) {
    const verifierLine = findVerifierCommandLine(publish, script);
    if (verifierLine === 0 || (publishCommandLine > 0 && verifierLine > publishCommandLine)) {
      violations.push({
        path: publishPath,
        line:
          findOptionalLine(publish, new RegExp(escapeRegex(script))) ||
          findLine(publish, /npm publish/),
        message: `publish workflow must run the ${label} policy verifier before publishing`,
      });
    }
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
