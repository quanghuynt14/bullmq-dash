import { describe, expect, it } from "bun:test";
import { getLockfilePolicyViolations } from "./lockfile-policy.js";
import { BUN_PACKAGE_MANAGER } from "./publish-policy.js";

const validPackageJson = JSON.stringify({ packageManager: BUN_PACKAGE_MANAGER });
const validWorkflows = {
  ".github/workflows/ci.yml": "steps:\n  - run: bun install --frozen-lockfile\n",
  ".github/workflows/publish.yml": "steps:\n  - run: bun install --frozen-lockfile\n",
};

describe("getLockfilePolicyViolations", () => {
  it("accepts the pinned Bun lockfile setup", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: validWorkflows,
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([]);
  });

  it("rejects a mismatched packageManager pin", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: JSON.stringify({ packageManager: "bun@1.3.12" }),
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: validWorkflows,
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([
      {
        path: "package.json",
        message: `packageManager must be pinned to ${BUN_PACKAGE_MANAGER}`,
      },
    ]);
  });

  it("rejects missing or untracked bun.lock", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json"],
        workflowFiles: validWorkflows,
        trackedFiles: ["package.json"],
      }),
    ).toEqual([
      { path: "bun.lock", message: "bun.lock must exist" },
      { path: "bun.lock", message: "bun.lock must be tracked in git" },
    ]);
  });

  it("rejects competing package manager lockfiles", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml"],
        workflowFiles: validWorkflows,
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([
      {
        path: "package-lock.json",
        message: "package-lock.json must not exist; Bun is the only supported package manager",
      },
      {
        path: "pnpm-lock.yaml",
        message: "pnpm-lock.yaml must not exist; Bun is the only supported package manager",
      },
    ]);
  });

  it("rejects workflow installs that do not freeze the lockfile", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: {
          ".github/workflows/ci.yml": "steps:\n  - run: bun install\n",
          ".github/workflows/publish.yml": "steps:\n  - run: bun install --frozen-lockfile\n",
        },
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 2,
        message: "workflow must install dependencies with bun install --frozen-lockfile",
      },
      {
        path: ".github/workflows/ci.yml",
        line: 2,
        message: "workflow must not run bun install without --frozen-lockfile",
      },
    ]);
  });

  it("does not accept commented or echoed frozen install commands", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: {
          ".github/workflows/ci.yml":
            'steps:\n  # - run: bun install --frozen-lockfile\n  - run: echo "bun install --frozen-lockfile"\n',
          ".github/workflows/publish.yml": "steps:\n  - run: bun install --frozen-lockfile\n",
        },
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: undefined,
        message: "workflow must install dependencies with bun install --frozen-lockfile",
      },
    ]);
  });

  it("rejects chained mutable installs after a frozen install", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: {
          ".github/workflows/ci.yml":
            "steps:\n  - run: bun install --frozen-lockfile && bun install\n",
          ".github/workflows/publish.yml": "steps:\n  - run: bun install --frozen-lockfile\n",
        },
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 2,
        message: "workflow must not run bun install without --frozen-lockfile",
      },
    ]);
  });

  it("accepts frozen installs inside run blocks", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: {
          ".github/workflows/ci.yml": "steps:\n  - run: |\n      bun install --frozen-lockfile\n",
          ".github/workflows/publish.yml": "steps:\n  - run: bun install --frozen-lockfile\n",
        },
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([]);
  });

  it("accepts frozen installs with extra flags before --frozen-lockfile", () => {
    expect(
      getLockfilePolicyViolations({
        packageJson: validPackageJson,
        rootFiles: ["package.json", "bun.lock"],
        workflowFiles: {
          ".github/workflows/ci.yml":
            "steps:\n  - run: bun install --production --frozen-lockfile\n",
          ".github/workflows/publish.yml":
            "steps:\n  - run: bun install --frozen-lockfile --ignore-scripts\n",
        },
        trackedFiles: ["package.json", "bun.lock"],
      }),
    ).toEqual([]);
  });
});
