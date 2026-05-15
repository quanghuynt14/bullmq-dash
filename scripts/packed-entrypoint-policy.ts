export interface PackedEntrypointPolicyViolation {
  pattern: string;
}

const forbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "eval", pattern: /\beval\s*\(/ },
  { label: "Function constructor", pattern: /\b(?:new\s+)?Function\s*\(/ },
  { label: "vm import", pattern: /["'](?:node:)?vm["']/ },
  { label: "child_process import", pattern: /["'](?:node:)?child_process["']/ },
  { label: "Bun.spawn", pattern: /\bBun\.spawn\s*\(/ },
  { label: "Bun.spawnSync", pattern: /\bBun\.spawnSync\s*\(/ },
  { label: "Bun shell", pattern: /\bBun\.\$\s*`/ },
];

export function getPackedEntrypointPolicyViolations(
  content: string,
): PackedEntrypointPolicyViolation[] {
  return forbiddenPatterns
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => ({ pattern: label }));
}

export function assertPackedEntrypointPolicy(content: string): void {
  const violations = getPackedEntrypointPolicyViolations(content);
  if (violations.length > 0) {
    throw new Error(
      `Packed dist/index.js must not contain risky runtime primitives: ${violations
        .map((violation) => violation.pattern)
        .join(", ")}`,
    );
  }
}
