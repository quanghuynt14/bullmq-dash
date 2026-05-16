# Security Policy

## Supported Versions

Security fixes are released as new npm versions. Already-published npm versions
are immutable and cannot be modified in place or reused after unpublish. See
npm's unpublish policy:
https://docs.npmjs.com/policies/unpublish/

## Reporting a Vulnerability

Please report suspected vulnerabilities through GitHub Security Advisories for
this repository when available. If that is not available, open an issue with a
minimal description and avoid posting exploit details publicly.

Include:

- Affected version
- Reproduction steps
- Expected impact
- Whether the issue affects local CLI use, Redis connectivity, package
  publication, or dependency supply chain

## Release Verification

Before publishing, run:

```bash
bun run security:release
```

That command runs, in order:

1. `bun run security:verify-source-control` — confirms forbidden local-only
   files (`dist/`, `.env`, `.envrc`, `.npmrc`, `.package.json.prepack-backup`,
   `*.tgz`) are ignored and not tracked.
2. `bun run security:verify-lockfile` — confirms `packageManager` is pinned to
   the expected Bun version, `bun.lock` is tracked, no competing lockfiles
   exist, and CI/publish workflows install with `--frozen-lockfile`.
3. `bun run security:verify-workflows` — confirms CI and publish workflows pin
   GitHub Actions by commit SHA, reject `pull_request_target` and unsafe
   `${{ github.event.* }}` interpolation, use read-only CI tokens, scope
   secrets to approved steps, keep npm lifecycle scripts enabled, publish with
   provenance, install Socket CLI `1.1.94`, and run the post-publish Socket
   score gate.
4. `bun run security:verify-package` — packs the release tarball and verifies
   the source manifest, no direct `ioredis` or `zod` imports in source or the
   packed entrypoint, no dynamic-code or shell primitives in source or
   `dist/index.js`, no credentialed Redis URL examples in packed text, the
   stripped publish manifest, packed size and entry-count limits, and the
   expected runtime dependency set (`@opentui/core`, `bullmq`).
5. `bun run security:score` — scores the published package via the pinned
   Socket CLI (`@socketsecurity/cli@1.1.94`) and compares Socket's alerts
   against an accepted-alert allowlist. The gate exits nonzero only when
   Socket reports an alert type outside that set.

The accepted-alert set is defined in
[`scripts/socket-score.ts`](scripts/socket-score.ts) as `ACCEPTED_ALERT_TYPES`.
It currently includes only inherent-capability alerts: the capabilities a
Redis monitoring tool legitimately needs (`networkAccess`, `urlStrings`,
`filesystemAccess`, `envVars`), Socket's transient `recentlyPublished`
window, and the build-shape alerts inherent to the published graph
(`hasNativeCode`, `minifiedFile`).

Risk-signal alert types (`debugAccess`, `gptAnomaly`, `newAuthor`,
`nonpermissiveLicense`, `obfuscatedFile`, `shellAccess`, `unmaintained`,
`usesEval`) are intentionally not pre-accepted — even when they appear in
the `bullmq` or `@opentui/core` transitive graph. When one fires, investigate
the offending transitive, then either revert the dependency change or add
the alert type to `ACCEPTED_RISK_ALERTS` in `scripts/socket-score.ts` with
a one-line citation. Expect the gate to fire on first publish, and on any
dependency update that introduces a new alert type, until each actually-
observed alert has been triaged this way.

## Historical Audit

`bun run security:audit-0.2.7` audits the immutable `bullmq-dash@0.2.7`
artifact on npm. That version was published with five package-self alerts
(`networkAccess`, `urlStrings`, `filesystemAccess`, `envVars`,
`recentlyPublished`) and fifteen transitive alerts across its dependency
graph. Because npm versions are immutable, those alerts will remain on
`0.2.7` indefinitely. The script is preserved as historical evidence; it
exits nonzero so the artifact's permanent state is not mistaken for "clean."

## Supply Chain

- GitHub Actions in CI and publish workflows are pinned by commit SHA.
- Dependabot tracks the `github-actions` ecosystem so SHA pins refresh
  through reviewed updates rather than mutable tag drift.
- The npm publish workflow declares `publishConfig.provenance: true`, so
  every published version carries a signed provenance attestation linking
  the tarball back to the GitHub Actions build that produced it.
- Bun is pinned via `packageManager`; CI and publish workflows install with
  `--frozen-lockfile`.

## Branch Protection

`.github/CODEOWNERS` routes review of the gate suite (workflows,
verifier scripts, `package.json`, `bun.lock`, `SECURITY.md`) to the
maintainer. CODEOWNERS is advisory unless the `master` branch
protection rule enforces it. The required settings on `master` are:

- Require a pull request before merging.
- Require review from Code Owners.
- Dismiss stale pull request approvals when new commits are pushed.
- Require status checks to pass before merging, and include:
  - `Typecheck`, `Lint`, `Check formatting`, `Test`
  - `Verify source-control policy`, `Verify lockfile policy`,
    `Verify workflow policy`, `Verify package contents`
- Restrict who can push to matching branches (maintainer only).
- Restrict who can create matching tags (maintainer only) — the publish
  workflow triggers on `release: types: [published]`, so an attacker
  with write access who can create a release from an arbitrary commit
  can publish that commit to npm.

Without these settings the gate suite is bypassable by a single PR.

## Publish Recovery

`bun scripts/publish-manifest.ts prepack` writes a stripped publish
manifest and saves the source manifest at `.package.json.prepack-backup`
(gitignored). `postpack` and `postpublish` restore it; the script's
SIGINT/SIGTERM handlers restore on Ctrl-C / SIGTERM. If `npm publish`
crashes between `prepack` and `postpack` (host killed, OOM, an uncatchable
parent failure), the working tree is left with the stripped manifest in
place. To recover:

```bash
bun scripts/publish-manifest.ts restore
```

That re-asserts the source-manifest policy after restoring, so a
corrupted backup fails loudly rather than silently overwriting
`package.json`.
