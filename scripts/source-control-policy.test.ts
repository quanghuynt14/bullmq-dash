import { describe, expect, it } from "bun:test";
import { getSourceControlPolicyViolations } from "./source-control-policy.js";

const validGitignore = `
dist/
.env
.env.*
.envrc
.npmrc
.package.json.prepack-backup
*.tgz
`;

describe("getSourceControlPolicyViolations", () => {
  it("accepts ignored secret files when none are tracked", () => {
    expect(
      getSourceControlPolicyViolations({
        gitignore: validGitignore,
        trackedFiles: ["package.json", "src/index.ts"],
      }),
    ).toEqual([]);
  });

  it("rejects missing gitignore entries", () => {
    expect(
      getSourceControlPolicyViolations({
        gitignore: ".env\n",
        trackedFiles: [],
      }),
    ).toEqual([
      { message: ".gitignore must include dist/" },
      { message: ".gitignore must include .env.*" },
      { message: ".gitignore must include .envrc" },
      { message: ".gitignore must include .npmrc" },
      { message: ".gitignore must include .package.json.prepack-backup" },
      { message: ".gitignore must include *.tgz" },
    ]);
  });

  it("rejects tracked build output, secret-bearing files, and generated publish artifacts", () => {
    expect(
      getSourceControlPolicyViolations({
        gitignore: validGitignore,
        trackedFiles: [
          "dist/index.js",
          ".env",
          ".env.local",
          ".envrc",
          ".npmrc",
          ".package.json.prepack-backup",
          "bullmq-dash-0.3.0.tgz",
        ],
      }),
    ).toEqual([
      { message: "Forbidden local-only file must not be tracked: dist/index.js" },
      { message: "Forbidden local-only file must not be tracked: .env" },
      { message: "Forbidden local-only file must not be tracked: .env.local" },
      { message: "Forbidden local-only file must not be tracked: .envrc" },
      { message: "Forbidden local-only file must not be tracked: .npmrc" },
      { message: "Forbidden local-only file must not be tracked: .package.json.prepack-backup" },
      { message: "Forbidden local-only file must not be tracked: bullmq-dash-0.3.0.tgz" },
    ]);
  });

  it("rejects forbidden local-only files when they are tracked in subdirectories", () => {
    expect(
      getSourceControlPolicyViolations({
        gitignore: validGitignore,
        trackedFiles: [
          "packages/worker/dist/index.js",
          "packages/worker/.env",
          "packages/worker/.env/secret",
          "packages/worker/.env.local",
          "packages/worker/.envrc",
          "packages/worker/.npmrc",
          "packages/worker/.package.json.prepack-backup",
          "packages/worker/.package.json.prepack-backup/package.json",
        ],
      }),
    ).toEqual([
      { message: "Forbidden local-only file must not be tracked: packages/worker/dist/index.js" },
      { message: "Forbidden local-only file must not be tracked: packages/worker/.env" },
      { message: "Forbidden local-only file must not be tracked: packages/worker/.env/secret" },
      { message: "Forbidden local-only file must not be tracked: packages/worker/.env.local" },
      { message: "Forbidden local-only file must not be tracked: packages/worker/.envrc" },
      { message: "Forbidden local-only file must not be tracked: packages/worker/.npmrc" },
      {
        message:
          "Forbidden local-only file must not be tracked: packages/worker/.package.json.prepack-backup",
      },
      {
        message:
          "Forbidden local-only file must not be tracked: packages/worker/.package.json.prepack-backup/package.json",
      },
    ]);
  });

  it("allows tracked env templates", () => {
    expect(
      getSourceControlPolicyViolations({
        gitignore: validGitignore,
        trackedFiles: [
          ".env.example",
          ".env.sample",
          ".env.template",
          "packages/worker/.env.example",
        ],
      }),
    ).toEqual([]);
  });
});
