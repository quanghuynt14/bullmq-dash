import { FORBIDDEN_RUNTIME_PRIMITIVES } from "./runtime-source-policy.js";

export interface PackedEntrypointPolicyViolation {
  pattern: string;
}

export function getPackedEntrypointPolicyViolations(
  content: string,
): PackedEntrypointPolicyViolation[] {
  return FORBIDDEN_RUNTIME_PRIMITIVES.filter(({ pattern }) => pattern.test(content)).map(
    ({ label }) => ({ pattern: label }),
  );
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
