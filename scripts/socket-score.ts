import { readFileSync } from "node:fs";
import {
  formatAlert,
  parseJsonFromNoisyOutput,
  runPinnedSocket,
  type SocketAlert,
  type SocketScore,
} from "./audit-socket-target.js";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

const PACKAGE_VERSION_LOOKUP_TIMEOUT_MS = 10_000;

// bullmq-dash is a Redis monitoring tool: it legitimately needs network
// access, URL strings, filesystem reads, and env var interpolation, and its
// dependency graph (bullmq, @opentui/core, and their transitives) brings
// alerts inherent to those libraries. Socket scores will always flag these.
// The gate's job is to catch *new* alert types, not block on the inherent set.
// recentlyPublished is transient — Socket clears it after the 72h new-publish
// window.
export const ACCEPTED_ALERT_TYPES: ReadonlySet<string> = new Set([
  "debugAccess",
  "envVars",
  "filesystemAccess",
  "gptAnomaly",
  "hasNativeCode",
  "minifiedFile",
  "networkAccess",
  "newAuthor",
  "nonpermissiveLicense",
  "obfuscatedFile",
  "recentlyPublished",
  "shellAccess",
  "unmaintained",
  "urlStrings",
  "usesEval",
]);

export interface ScoreGateSummary {
  packageSpec: string;
  expectedPurl: string;
  socketOk: boolean;
  socketPurl: string;
  alertCount: number;
  alertTypes: string[];
  acceptedAlertTypes: string[];
  unexpectedAlertTypes: string[];
  unexpectedAlerts: string[];
  clean: boolean;
}

export function getPackageSpec(manifest: PackageManifest): string {
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error("package.json is missing a valid name");
  }

  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("package.json is missing a valid version");
  }

  return `${manifest.name}@${manifest.version}`;
}

function collectAlerts(score: SocketScore): SocketAlert[] {
  return [...(score.data?.self?.alerts ?? []), ...(score.data?.transitively?.alerts ?? [])];
}

export function buildScoreGateSummary(packageSpec: string, score: SocketScore): ScoreGateSummary {
  const alerts = collectAlerts(score);
  const expectedPurl = `pkg:npm/${packageSpec}`;
  const socketPurl = typeof score.data?.purl === "string" ? score.data.purl : "unknown";
  const socketOk = score.ok === true;

  const alertTypes = [...new Set(alerts.map((alert) => String(alert.name ?? "unknown")))].toSorted();
  const acceptedAlertTypes = alertTypes.filter((name) => ACCEPTED_ALERT_TYPES.has(name));
  const unexpectedAlertTypes = alertTypes.filter((name) => !ACCEPTED_ALERT_TYPES.has(name));
  const unexpectedAlerts = alerts
    .filter((alert) => !ACCEPTED_ALERT_TYPES.has(String(alert.name ?? "")))
    .map(formatAlert);

  return {
    packageSpec,
    expectedPurl,
    socketOk,
    socketPurl,
    alertCount: alerts.length,
    alertTypes,
    acceptedAlertTypes,
    unexpectedAlertTypes,
    unexpectedAlerts,
    clean: socketOk && socketPurl === expectedPurl && unexpectedAlerts.length === 0,
  };
}

export function renderScoreGateSummary(summary: ScoreGateSummary): {
  stdout: string[];
  stderr: string[];
  exitCode: number;
} {
  const stdout = [
    `Socket score gate: npm/${summary.packageSpec}`,
    `Socket ok: ${summary.socketOk}`,
    `Socket purl: ${summary.socketPurl}`,
    `Alert count: ${summary.alertCount}`,
    `Accepted alert types: ${summary.acceptedAlertTypes.join(", ") || "none"}`,
    `Unexpected alert types: ${summary.unexpectedAlertTypes.join(", ") || "none"}`,
  ];
  const stderr: string[] = [];

  if (summary.unexpectedAlerts.length > 0) {
    stdout.push("Unexpected alerts (gate-blocking):");
    for (const alert of summary.unexpectedAlerts.slice(0, 10)) {
      stdout.push(`- ${alert}`);
    }
  }

  if (!summary.clean) {
    if (!summary.socketOk) {
      stderr.push("Socket response not ok.");
    }
    if (summary.socketPurl !== summary.expectedPurl) {
      stderr.push(
        `Socket target mismatch: expected ${summary.expectedPurl}, got ${summary.socketPurl}.`,
      );
    }
    if (summary.unexpectedAlertTypes.length > 0) {
      stderr.push(
        `Socket reports unexpected alert types: ${summary.unexpectedAlertTypes.join(", ")}. Review whether they're inherent to a new dependency (and should join the accepted list) or signal a real regression.`,
      );
    }
    stderr.push(`npm/${summary.packageSpec} failed the Socket package score gate.`);
    return { stdout, stderr, exitCode: 1 };
  }

  stdout.push(
    `npm/${summary.packageSpec} passed the Socket package score gate (all alerts are in the accepted set).`,
  );
  return { stdout, stderr, exitCode: 0 };
}

export function isUnavailablePackageScoreError(message: string): boolean {
  return /fetch failed|purl\/score|not available in the npm registry|timed out after/.test(message);
}

async function packageVersionExists(packageSpec: string): Promise<boolean> {
  const proc = Bun.spawn(["npm", "view", packageSpec, "version", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, PACKAGE_VERSION_LOOKUP_TIMEOUT_MS);

  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));

  return !timedOut && exitCode === 0 && stdout.trim().length > 0;
}

async function fetchScoreGateSummary(packageSpec: string): Promise<ScoreGateSummary> {
  if (!(await packageVersionExists(packageSpec))) {
    throw new Error(`npm/${packageSpec} is not available in the npm registry`);
  }

  const { stdout, stderr } = await runPinnedSocket([
    "package",
    "score",
    "npm",
    packageSpec,
    "--json",
  ]);
  if (stderr.length > 0) {
    console.error(stderr.trimEnd());
  }

  return buildScoreGateSummary(packageSpec, parseJsonFromNoisyOutput<SocketScore>(stdout));
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync("package.json", "utf-8")) as PackageManifest;
  const packageSpec = getPackageSpec(manifest);

  console.error(`Scoring published package npm/${packageSpec} via Socket...`);
  console.error("Note: Socket package score only works after this exact version is published.");

  try {
    const summary = await fetchScoreGateSummary(packageSpec);
    const rendered = renderScoreGateSummary(summary);

    for (const line of rendered.stdout) {
      console.log(line);
    }
    for (const line of rendered.stderr) {
      console.error(line);
    }

    process.exit(rendered.exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUnavailablePackageScoreError(message)) {
      console.error(
        `Socket could not score npm/${packageSpec}. Package scores are only available after ` +
          "that exact name and version exists in the npm registry, and the score request must complete successfully.",
      );
      process.exit(1);
    }

    throw error;
  }
}

if (import.meta.main) {
  await main();
}
