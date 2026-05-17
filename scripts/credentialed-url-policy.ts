// Literal-example guard, *not* a general secret-scanner.
//
// Job: catch the specific footgun of a README / packed-text snippet that
// contains a literal `redis://user:pass@host` form. That shape becomes a
// real credential leak the moment someone copy-pastes it from an npm
// listing or a published doc page, even if the password is a placeholder
// — Socket / supply-chain scanners will surface it as a finding, and
// downstream users start treating the literal as authoritative.
//
// What this guard does NOT catch (deliberately, and the reason it lives
// as a focused check rather than a generic scanner):
//   - base64-encoded or percent-encoded credentialed URLs
//   - `redis://${USER}:${PASS}@host` env-var template forms
//   - split-string concatenations like `"redis://" + creds + "@host"`
//   - any credential not in URL-authority form
//
// For the broader secret-scanner job, defer to git-secrets / trufflehog /
// gitleaks at the repo level. This guard is intentionally narrow because
// scope creep here would either produce noisy false positives in code
// examples or pretend to provide coverage it cannot actually provide.
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
      `Packed artifacts must not contain literal credentialed Redis URL examples: ${violations
        .map((violation) => violation.artifact)
        .join(", ")}`,
    );
  }
}
