import { describe, expect, it } from "bun:test";
import { getPinnedSocketCliVersion, getWorkflowPolicyViolations } from "./workflow-policy.js";

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
      - run: npm install --global @socketsecurity/cli@1.1.94
      - run: bun run security:score
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

  it("extracts the publish-pinned Socket CLI version", () => {
    expect(getPinnedSocketCliVersion(validPublish)).toBe("1.1.94");
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
      }),
    ).toEqual([
      {
        path: ".github/workflows/ci.yml",
        line: 2,
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
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must publish with npm provenance enabled",
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
            "      - run: bun run security:score",
            "      - run: bun run security:score\n      - run: bun run security:verify-lockfile",
          ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 18,
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
            "      - run: bun run security:score",
            "      - run: bun run security:score\n      - run: bun run security:verify-source-control",
          ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 18,
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
            "      - run: bun run security:score",
            "      - run: bun run security:score\n      - run: bun run security:verify-workflows",
          ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 18,
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

  it("rejects publish workflows without a post-publish Socket score gate", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:score\n",
          "",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must score the just-published package with Socket",
      },
    ]);
  });

  it("rejects publish workflows where the post-publish Socket score is only mentioned in a comment", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:score",
          "      # run: bun run security:score",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must score the just-published package with Socket",
      },
    ]);
  });

  it("rejects publish workflows where the post-publish Socket score is only echoed", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:score",
          '      - run: echo "bun run security:score"',
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message: "publish workflow must score the just-published package with Socket",
      },
    ]);
  });

  it("rejects publish workflows that install the Socket CLI without an exact version", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "npm install --global @socketsecurity/cli@1.1.94",
          "npm install --global @socketsecurity/cli@latest",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 17,
        message:
          "publish workflow must install Socket CLI 1.1.94 after publishing and before scoring",
      },
    ]);
  });

  it("rejects publish workflows that install a different exact Socket CLI version", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "npm install --global @socketsecurity/cli@1.1.94",
          "npm install --global @socketsecurity/cli@1.1.93",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 17,
        message:
          "publish workflow must install Socket CLI 1.1.94 after publishing and before scoring",
      },
    ]);
  });

  it("rejects publish workflows that replace an exact Socket CLI install with an unpinned one", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:score",
          "      - run: npm install --global @socketsecurity/cli@latest\n      - run: bun run security:score",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 18,
        message:
          "publish workflow must install Socket CLI 1.1.94 after publishing and before scoring",
      },
    ]);
  });

  it("rejects publish workflows that use npm aliases for an unpinned Socket CLI install", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:score",
          "      - run: npm i -g @socketsecurity/cli@latest\n      - run: bun run security:score",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 18,
        message:
          "publish workflow must install Socket CLI 1.1.94 after publishing and before scoring",
      },
    ]);
  });

  it("rejects publish workflows that install the Socket CLI before publishing", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: npm publish --provenance --access public\n      - run: npm install --global @socketsecurity/cli@1.1.94",
          "      - run: npm install --global @socketsecurity/cli@1.1.94\n      - run: npm publish --provenance --access public",
        ),
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 16,
        message:
          "publish workflow must install Socket CLI 1.1.94 after publishing and before scoring",
      },
    ]);
  });

  it("allows post-publish Socket scoring inside a run block", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": validPublish.replace(
          "      - run: bun run security:score",
          `      - run: |
          if bun run security:score; then
            exit 0
          fi`,
        ),
      }),
    ).toEqual([]);
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
        line: 19,
        message: "secrets must only be passed through approved publish step env entries",
      },
    ]);
  });

  it("allows only the approved publish and Socket token env entries", () => {
    expect(
      getWorkflowPolicyViolations({
        ".github/workflows/ci.yml": validCi,
        ".github/workflows/publish.yml": `${validPublish}      - env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n          SOCKET_CLI_API_TOKEN: \${{ secrets.SOCKET_CLI_API_TOKEN }}\n          OTHER_TOKEN: \${{ secrets.OTHER_TOKEN }}\n`,
      }),
    ).toEqual([
      {
        path: ".github/workflows/publish.yml",
        line: 22,
        message: "secrets must only be passed through approved publish step env entries",
      },
    ]);
  });
});
