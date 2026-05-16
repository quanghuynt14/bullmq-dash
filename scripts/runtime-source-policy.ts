import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REMOVED_DIRECT_DEPENDENCIES } from "./publish-policy.js";

// Shared with packed-entrypoint-policy.ts so adding e.g. `WebAssembly.compile`
// or `node:worker_threads` here automatically tightens both gates.
export const FORBIDDEN_RUNTIME_PRIMITIVES: Array<{ label: string; pattern: RegExp }> = [
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
  // Accept any of the three string-literal quotes — including backticks, so
  // `import(\`ioredis\`)` and `require(\`zod\`)` don't slip past the gate.
  const quote = `["'\\\`]`;
  const nonQuote = `[^"'\\\`]`;
  const forbiddenReference = new RegExp(
    `from\\s+${quote}(${removedDependencyPattern})(?:/${nonQuote}*)?${quote}|import\\s+${quote}(${removedDependencyPattern})(?:/${nonQuote}*)?${quote}|import\\(${quote}(${removedDependencyPattern})(?:/${nonQuote}*)?${quote}\\)|require\\(${quote}(${removedDependencyPattern})(?:/${nonQuote}*)?${quote}\\)`,
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
    return FORBIDDEN_RUNTIME_PRIMITIVES.filter(({ pattern }) => pattern.test(source)).map(
      ({ label }) => `${relative(process.cwd(), path)}: ${label}`,
    );
  });
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
