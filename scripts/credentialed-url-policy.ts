export interface CredentialedUrlPolicyViolation {
  artifact: string;
}

const CREDENTIALED_REDIS_URL = /\brediss?:\/\/[^/\s"'`]*:[^@\s"'`]+@/;

export function getCredentialedUrlPolicyViolations(
  artifacts: Record<string, string>,
): CredentialedUrlPolicyViolation[] {
  return Object.entries(artifacts)
    .filter(([, content]) => CREDENTIALED_REDIS_URL.test(content))
    .map(([artifact]) => ({ artifact }));
}

export function assertNoCredentialedRedisUrls(artifacts: Record<string, string>): void {
  const violations = getCredentialedUrlPolicyViolations(artifacts);
  if (violations.length > 0) {
    throw new Error(
      `Packed artifacts must not contain credentialed Redis URL examples: ${violations
        .map((violation) => violation.artifact)
        .join(", ")}`,
    );
  }
}
