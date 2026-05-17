import { describe, expect, it } from "bun:test";
import { getWorkflowPolicyViolations } from "./workflow-policy.js";

const checkoutSha = "34e114876b0b11c390a56381ad16ebd13914f8d5";
const validCi = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    steps:
      - uses: actions/checkout@${checkoutSha} # v4
      - run: bun install --frozen-lockfile --ignore-scripts
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-package
      - run: bun run security:verify-source-control
      - run: bun run security:verify-workflows
`;

const validPublish = `name: Publish to npm
on:
  release:
    types: [published]
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    steps:
      - uses: actions/checkout@${checkoutSha} # v4
      - run: bun run security:verify-source-control
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-workflows
      - run: bun run security:verify-package
      - run: npm publish --provenance --access public
`;

describe("getWorkflowPolicyViolations", () => {
  it("allows workflow actions pinned to commit SHAs", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([]);
  });

  it("rejects when the publish workflow is missing entirely", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 1,
        message: "publish workflow must exist (.github/workflows/publish.yml)",
      },
    ]);
  });

  it("accepts npm publish with swapped --provenance / --access public order", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "npm publish --provenance --access public",
          "npm publish --access public --provenance",
        ),
      }),
    ).toEqual([]);
  });

  it("rejects publish workflows where bun install runs without --ignore-scripts", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - run: bun install --frozen-lockfile\n`,
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 17,
        message:
          "publish workflow must run bun install with --ignore-scripts to block transitive postinstall scripts",
      },
    ]);
  });

  it("accepts publish workflows where bun install includes --ignore-scripts", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - run: bun install --frozen-lockfile --ignore-scripts\n`,
      }),
    ).toEqual([]);
  });

  // Regression: a bare `\b--ignore-scripts\b` regex matches `=false`, `=0`,
  // `--no-ignore-scripts`, and `--ignore-scripts-no` because `-` and `=` are
  // non-word characters. Each of those disables transitive postinstall
  // suppression on the privileged publish job — the gate must reject them.
  it.each([
    ["--ignore-scripts=false", "bun install --frozen-lockfile --ignore-scripts=false"],
    ["--ignore-scripts=0", "bun install --frozen-lockfile --ignore-scripts=0"],
    ["--ignore-scripts=off", "bun install --frozen-lockfile --ignore-scripts=off"],
    ["--no-ignore-scripts", "bun install --frozen-lockfile --no-ignore-scripts"],
    ["--ignore-scripts-no", "bun install --frozen-lockfile --ignore-scripts-no"],
    ["--ignore-scripts-foo", "bun install --frozen-lockfile --ignore-scripts-foo"],
  ])("rejects publish workflows where bun install uses %s instead of a real flag", (_l, run) => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - run: ${run}\n`,
      }),
    ).toContainEqual({
      path: ".github/workflows/publish.yml",
      line: 17,
      message:
        "publish workflow must run bun install with --ignore-scripts to block transitive postinstall scripts",
    });
  });

  it("accepts explicit truthy assignment forms of --ignore-scripts", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - run: bun install --frozen-lockfile --ignore-scripts=true\n`,
      }),
    ).toEqual([]);
  });

  it("allows bun install --ignore-scripts even though the flag is banned on npm", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          "      - run: bun install --frozen-lockfile --ignore-scripts\n      - run: npm publish --provenance --access public",
        ),
      }),
    ).toEqual([]);
  });

  it("rejects CI workflows where bun install runs without --ignore-scripts", () => {
    // A transitive postinstall on a PR build can poison the runner cache or
    // tamper with the working tree before security:verify-package packs it.
    // CI lacks id-token but still has filesystem access to the
    // pre-publish source tree, so the same rule that protects publish.yml
    // protects ci.yml. Drop the --ignore-scripts flag and the gate must fire.
    const ciWithoutFlag = validCi.replace(
      "bun install --frozen-lockfile --ignore-scripts",
      "bun install --frozen-lockfile",
    );
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": ciWithoutFlag,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toContainEqual({
      path: ".github/workflows/ci.yml",
      line: 10,
      message:
        "CI workflow must run bun install with --ignore-scripts to block transitive postinstall scripts",
    });
  });

  it.each([
    ["--ignore-scripts=false", "bun install --frozen-lockfile --ignore-scripts=false"],
    ["--no-ignore-scripts", "bun install --frozen-lockfile --no-ignore-scripts"],
    ["--ignore-scripts-no", "bun install --frozen-lockfile --ignore-scripts-no"],
  ])("rejects CI workflows where bun install uses %s instead of a real flag", (_l, run) => {
    const ciWithBogusFlag = validCi.replace("bun install --frozen-lockfile --ignore-scripts", run);
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": ciWithBogusFlag,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toContainEqual({
      path: ".github/workflows/ci.yml",
      line: 10,
      message:
        "CI workflow must run bun install with --ignore-scripts to block transitive postinstall scripts",
    });
  });

  it("rejects workflow actions pinned only to mutable tags", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `permissions:
  contents: read
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-package
      - run: bun run security:verify-source-control
      - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 6,
        message: "actions/checkout@v4 must be pinned to a 40-character commit SHA",
      },
    ]);
  });

  it("rejects pull_request_target triggers", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `on:
  pull_request_target:
permissions:
  contents: read
jobs: {}
steps:
  - run: bun run security:verify-lockfile
  - run: bun run security:verify-package
  - run: bun run security:verify-source-control
  - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 2,
        message: "pull_request_target is not allowed in release or CI workflows",
      },
    ]);
  });

  it("rejects pull_request_target inline-array triggers", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `on:
  pull_request_target: [opened, synchronize]
permissions:
  contents: read
jobs: {}
steps:
  - run: bun run security:verify-lockfile
  - run: bun run security:verify-package
  - run: bun run security:verify-source-control
  - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 2,
        message: "pull_request_target is not allowed in release or CI workflows",
      },
    ]);
  });

  it("rejects pull_request_target as a scalar trigger on the on: line", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `on: pull_request_target
permissions:
  contents: read
jobs: {}
steps:
  - run: bun run security:verify-lockfile
  - run: bun run security:verify-package
  - run: bun run security:verify-source-control
  - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 1,
        message: "pull_request_target is not allowed in release or CI workflows",
      },
    ]);
  });

  it("rejects pull_request_target written as a block-sequence trigger", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `on:
  - pull_request_target
permissions:
  contents: read
jobs: {}
steps:
  - run: bun run security:verify-lockfile
  - run: bun run security:verify-package
  - run: bun run security:verify-source-control
  - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 2,
        message: "pull_request_target is not allowed in release or CI workflows",
      },
    ]);
  });

  it("rejects pull_request_target inside an inline trigger array on the on: line", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `on: [push, pull_request_target]
permissions:
  contents: read
jobs: {}
steps:
  - run: bun run security:verify-lockfile
  - run: bun run security:verify-package
  - run: bun run security:verify-source-control
  - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 1,
        message: "pull_request_target is not allowed in release or CI workflows",
      },
    ]);
  });

  it("rejects github.event interpolation into workflow commands", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `permissions:
  contents: read
jobs:
  test:
    steps:
      - run: echo "\${{ github.event.issue.title }}"
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-package
      - run: bun run security:verify-source-control
      - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 6,
        message: "github.event context must not be interpolated into workflow commands",
      },
    ]);
  });

  it("rejects github.event interpolation with no inner whitespace", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `permissions:
  contents: read
jobs:
  test:
    steps:
      - run: echo "\${{github.event.issue.title}}"
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-package
      - run: bun run security:verify-source-control
      - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 6,
        message: "github.event context must not be interpolated into workflow commands",
      },
    ]);
  });

  it("rejects uppercase GITHUB.EVENT interpolation", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": `permissions:
  contents: read
jobs:
  test:
    steps:
      - run: echo "\${{ GITHUB.EVENT.issue.title }}"
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-package
      - run: bun run security:verify-source-control
      - run: bun run security:verify-workflows
`,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 6,
        message: "github.event context must not be interpolated into workflow commands",
      },
    ]);
  });

  it("rejects CI workflows that request write permissions", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi.replace("contents: read", "contents: write"),
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 4,
        message: "CI workflow must set permissions.contents to read",
      },
      {
        path: ".github/workflows/ci.yml",
        line: 5,
        message: "CI workflow must not request write permissions",
      },
    ]);
  });

  it("rejects CI workflows without the lockfile policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi.replace(
          "      - run: bun run security:verify-lockfile\n",
          "",
        ),
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 8,
        message: "CI workflow must run the lockfile policy verifier",
      },
    ]);
  });

  it("rejects CI workflows without the package policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi.replace(
          "      - run: bun run security:verify-package\n",
          "",
        ),
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 8,
        message: "CI workflow must run the package policy verifier",
      },
    ]);
  });

  it("rejects CI workflows without the source-control policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi.replace(
          "      - run: bun run security:verify-source-control\n",
          "",
        ),
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 8,
        message: "CI workflow must run the source-control policy verifier",
      },
    ]);
  });

  it("rejects CI workflows without the workflow policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi.replace(
          "      - run: bun run security:verify-workflows\n",
          "",
        ),
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 8,
        message: "CI workflow must run the workflow policy verifier",
      },
    ]);
  });

  it("rejects publish workflows that run outside published releases", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "  release:\n    types: [published]",
          "  release:\n    types: [published]\n  push:",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 5,
        message: "publish workflow must not be triggered by push",
      },
    ]);
  });

  it("rejects publish workflows without npm provenance", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "npm publish --provenance --access public",
          "npm publish --access public",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must publish with npm provenance enabled",
      },
    ]);
  });

  it("rejects publish workflows that disable npm lifecycle scripts before publishing", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          "      - run: npm config set ignore-scripts true\n      - run: npm publish --provenance --access public",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must not disable npm lifecycle scripts",
      },
    ]);
  });

  it("rejects publish workflows that disable lifecycle scripts through npm env", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          "      - env:\n          NPM_CONFIG_IGNORE_SCRIPTS: true\n      - run: npm publish --provenance --access public",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 17,
        message: "publish workflow must not disable npm lifecycle scripts",
      },
    ]);
  });

  it("rejects publish workflows that disable lifecycle scripts through lowercase npm env", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          "      - env:\n          npm_config_ignore_scripts: true\n      - run: npm publish --provenance --access public",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 17,
        message: "publish workflow must not disable npm lifecycle scripts",
      },
    ]);
  });

  it("rejects publish workflows that disable lifecycle scripts with mixed-case flags", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          "      - run: npm publish --provenance --access public --IGNORE-SCRIPTS",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must not disable npm lifecycle scripts",
      },
    ]);
  });

  it("allows comments that mention ignore-scripts without disabling lifecycle scripts", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          "      # never use npm publish --ignore-scripts here\n      - run: npm publish --provenance --access public",
        ),
      }),
    ).toEqual([]);
  });

  it("rejects publish workflows without the lockfile policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:verify-lockfile\n",
          "",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 15,
        message: "publish workflow must run the lockfile policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows without the package policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:verify-package\n",
          "",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 15,
        message: "publish workflow must run the package policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows without the source-control policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:verify-source-control\n",
          "",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 15,
        message: "publish workflow must run the source-control policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows without the workflow policy verifier", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:verify-workflows\n",
          "",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 15,
        message: "publish workflow must run the workflow policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows that run the lockfile policy verifier only after publishing", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish
          .replace("      - run: bun run security:verify-lockfile\n", "")
          .replace(
            "      - run: npm publish --provenance --access public",
            "      - run: npm publish --provenance --access public\n      - run: bun run security:verify-lockfile",
          ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must run the lockfile policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows that run the source-control policy verifier only after publishing", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish
          .replace("      - run: bun run security:verify-source-control\n", "")
          .replace(
            "      - run: npm publish --provenance --access public",
            "      - run: npm publish --provenance --access public\n      - run: bun run security:verify-source-control",
          ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must run the source-control policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows that run the workflow policy verifier only after publishing", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish
          .replace("      - run: bun run security:verify-workflows\n", "")
          .replace(
            "      - run: npm publish --provenance --access public",
            "      - run: npm publish --provenance --access public\n      - run: bun run security:verify-workflows",
          ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must run the workflow policy verifier before publishing",
      },
    ]);
  });

  it("rejects publish workflows that run the package policy verifier only after publishing", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:verify-package\n      - run: npm publish --provenance --access public",
          "      - run: npm publish --provenance --access public\n      - run: bun run security:verify-package",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must run the package policy verifier before publishing",
      },
    ]);
  });

  // Regression: `findExecutableCommandLine` skips lines starting with
  // `echo` so an `echo "..."` placeholder can't satisfy a verifier-presence
  // check. Each verifier needs its own case — a future refactor that
  // narrows the `echo` filter would otherwise re-open the gap silently. The
  // expected violation line is the line where the (now-echoed) verifier text
  // appears, which is the line that `findOptionalLine(/security:verify-…/)`
  // still matches.
  it.each([
    [
      "security:verify-source-control",
      "publish workflow must run the source-control policy verifier before publishing",
      12,
    ],
    [
      "security:verify-lockfile",
      "publish workflow must run the lockfile policy verifier before publishing",
      13,
    ],
    [
      "security:verify-workflows",
      "publish workflow must run the workflow policy verifier before publishing",
      14,
    ],
    [
      "security:verify-package",
      "publish workflow must run the package policy verifier before publishing",
      15,
    ],
  ])("rejects publish workflows where %s is only echoed", (verifier, message, line) => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          `      - run: bun run ${verifier}`,
          `      - run: echo "bun run ${verifier}"`,
        ),
      }),
    ).toContainEqual({
      path: ".github/workflows/publish.yml",
      line,
      message,
    });
  });

  it("rejects secrets interpolated directly into workflow commands", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - run: echo "\${{ secrets.NPM_TOKEN }}"\n`,
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 17,
        message: "secrets must only be passed through approved publish step env entries",
      },
    ]);
  });

  it("rejects publish workflow secret env entries", () => {
    // The release job uses npm trusted publishing through GitHub OIDC, so it
    // should not receive long-lived npm or Socket credentials.
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n          SOCKET_CLI_API_TOKEN: \${{ secrets.SOCKET_CLI_API_TOKEN }}\n          OTHER_TOKEN: \${{ secrets.OTHER_TOKEN }}\n`,
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 18,
        message: "secrets must only be passed through approved publish step env entries",
      },
      {
        path: ".github/workflows/publish.yml",
        line: 19,
        message: "secrets must only be passed through approved publish step env entries",
      },
      {
        path: ".github/workflows/publish.yml",
        line: 20,
        message: "secrets must only be passed through approved publish step env entries",
      },
    ]);
  });

  it("rejects NODE_AUTH_TOKEN even when scoped to the npm publish step", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public",
          `      - env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n        run: npm publish --provenance --access public`,
        ),
      }),
    ).toContainEqual({
      path: ".github/workflows/publish.yml",
      line: 17,
      message: "secrets must only be passed through approved publish step env entries",
    });
  });

  it("rejects a second NODE_AUTH_TOKEN env binding on a non-publish step (YAML-backed attribution)", () => {
    // This is the attack the YAML-backed step boundary fix addresses:
    // a malicious PR adds two env bindings with the same literal text in
    // different steps. The line-level regex alone would mis-attribute a line
    // if the splitter were confused about step boundaries; the policy must
    // reject both bindings.
    const malicious = validPublish.replace(
      "      - run: npm publish --provenance --access public",
      `      - env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n        run: npm publish --provenance --access public\n      - env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n        run: ./malicious-thing`,
    );
    const violations = getWorkflowPolicyViolations({
      ".github/workflows/ci.yml": validCi,
      ".github/workflows/publish.yml": malicious,
    });
    expect(
      violations.filter(
        (v) =>
          v.message === "secrets must only be passed through approved publish step env entries",
      ).length,
    ).toBe(2);
  });

  it("rejects a workflow whose YAML shape is too ambiguous to attribute lines deterministically", () => {
    // List-shaped text inside a `run: |` block makes the regex splitter
    // see more step anchors than the parsed structure has. Rather than
    // silently mis-attribute, the linter must refuse to lint.
    const ambiguous = `name: Ambiguous
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    steps:
      - name: anchor 1
        run: |
          echo "hi"
          - run: nested-list-shaped-text
      - run: bun run security:verify-lockfile
      - run: bun run security:verify-package
      - run: bun run security:verify-source-control
      - run: bun run security:verify-workflows
`;
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": ambiguous,
        ".github/workflows/publish.yml": validPublish,
      }),
    ).toContainEqual({
      path: ".github/workflows/ci.yml",
      line: 1,
      message:
        "workflow step shape is ambiguous (line-splitter anchor count != parsed step count); simplify the YAML so the linter can attribute lines to steps deterministically",
    });
  });
});
