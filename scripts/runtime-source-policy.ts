import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REMOVED_DIRECT_DEPENDENCIES } from "./publish-policy.js";

export interface RuntimeCapabilityEvidence {
  redisNetwork: boolean;
  profileEnvironment: boolean;
  profileFileRead: boolean;
  redisUrlParsing: boolean;
}

const forbiddenRuntimePrimitivePatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "eval", pattern: /\beval\s*\(/ },
  { label: "Function constructor", pattern: /\b(?:new\s+)?Function\s*\(/ },
  { label: "vm import", pattern: /["'](?:node:)?vm["']/ },
  { label: "child_process import", pattern: /["'](?:node:)?child_process["']/ },
  { label: "Bun.spawn", pattern: /\bBun\.spawn\s*\(/ },
  { label: "Bun.spawnSync", pattern: /\bBun\.spawnSync\s*\(/ },
  { label: "Bun shell", pattern: /\bBun\.\$\s*`/ },
];

function getTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return getTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

export function containsRemovedDependencyReference(source: string): boolean {
  const removedDependencyPattern = REMOVED_DIRECT_DEPENDENCIES.join("|");
  const forbiddenReference = new RegExp(
    `from\\s+["'](${removedDependencyPattern})(?:/[^"']*)?["']|import\\s+["'](${removedDependencyPattern})(?:/[^"']*)?["']|import\\(["'](${removedDependencyPattern})(?:/[^"']*)?["']\\)|require\\(["'](${removedDependencyPattern})(?:/[^"']*)?["']\\)`,
  );

  return forbiddenReference.test(source);
}

export function assertNoRemovedDependencyReferences(source: string, label: string): void {
  if (containsRemovedDependencyReference(source)) {
    throw new Error(`${label} must not directly import removed dependencies`);
  }
}

export function getRuntimeSourcePolicyViolations(directory: string = "src"): string[] {
  return getTypeScriptFiles(directory)
    .map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }))
    .filter(({ source }) => containsRemovedDependencyReference(source))
    .map(({ path }) => relative(process.cwd(), path));
}

export function getRuntimePrimitivePolicyViolations(directory: string = "src"): string[] {
  return getTypeScriptFiles(directory).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return forbiddenRuntimePrimitivePatterns
      .filter(({ pattern }) => pattern.test(source))
      .map(({ label }) => `${relative(process.cwd(), path)}: ${label}`);
  });
}

export function getRuntimeCapabilityEvidence(
  files: Record<string, string> = {
    "src/index.ts": readFileSync("src/index.ts", "utf8"),
  },
): RuntimeCapabilityEvidence {
  const source = Object.values(files).join("\n");

  return {
    redisNetwork: /\bnew\s+RedisConnection\s*\(/.test(source) || /\bnew\s+Queue\s*\(/.test(source),
    profileEnvironment: /\bprocess\.env\b/.test(source),
    profileFileRead: /\b(?:readFileSync|existsSync)\s*\(/.test(source),
    redisUrlParsing: /\bnew\s+URL\s*\(/.test(source) || /\bredis(?:s)?:\/\//.test(source),
  };
}

export function formatRuntimeCapabilityEvidence(evidence: RuntimeCapabilityEvidence): string {
  const capabilities = [
    evidence.redisNetwork ? "Redis network access" : null,
    evidence.profileEnvironment ? "profile environment interpolation" : null,
    evidence.profileFileRead ? "profile config file reads" : null,
    evidence.redisUrlParsing ? "Redis URL parsing" : null,
  ].filter((capability): capability is string => capability !== null);

  return capabilities.length > 0
    ? capabilities.join(", ")
    : "no Redis network/config env/file/URL runtime capabilities";
}

export function assertRuntimeCapabilityEvidence(evidence = getRuntimeCapabilityEvidence()): void {
  const present = formatRuntimeCapabilityEvidence(evidence);

  if (
    evidence.redisNetwork ||
    evidence.profileEnvironment ||
    evidence.profileFileRead ||
    evidence.redisUrlParsing
  ) {
    throw new Error(
      `Runtime capability policy found non-clean base package capabilities: ${present}`,
    );
  }
}

export function assertRuntimeSourcePolicy(directory: string = "src"): void {
  const violations = getRuntimeSourcePolicyViolations(directory);
  const primitiveViolations = getRuntimePrimitivePolicyViolations(directory);

  if (violations.length > 0) {
    throw new Error(
      `Runtime source must not import removed direct dependencies: ${violations.join(", ")}`,
    );
  }

  if (primitiveViolations.length > 0) {
    throw new Error(
      `Runtime source must not contain risky runtime primitives: ${primitiveViolations.join(", ")}`,
    );
  }
}
