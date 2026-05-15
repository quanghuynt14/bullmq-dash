import { describe, expect, it } from "bun:test";
import {
  assertPackedEntrypointPolicy,
  getPackedEntrypointPolicyViolations,
} from "./packed-entrypoint-policy.js";

describe("getPackedEntrypointPolicyViolations", () => {
  it("allows ordinary bundled runtime code", () => {
    expect(
      getPackedEntrypointPolicyViolations(`
const statement = database.prepare("SELECT 1");
database.exec("PRAGMA journal_mode=WAL");
`),
    ).toEqual([]);
  });

  it("rejects eval and dynamic Function construction", () => {
    expect(
      getPackedEntrypointPolicyViolations(`
import vm from "node:vm";
eval(userInput);
new Function("return process.env");
Function("return process.env")();
`),
    ).toEqual([{ pattern: "eval" }, { pattern: "Function constructor" }, { pattern: "vm import" }]);
  });

  it("rejects shell-capable process APIs", () => {
    expect(
      getPackedEntrypointPolicyViolations(`
import cp from "node:child_process";
Bun.spawn(["sh", "-c", command]);
Bun.spawnSync(["sh", "-c", command]);
Bun.$\`rm -rf \${path}\`;
`),
    ).toEqual([
      { pattern: "child_process import" },
      { pattern: "Bun.spawn" },
      { pattern: "Bun.spawnSync" },
      { pattern: "Bun shell" },
    ]);
  });
});

describe("assertPackedEntrypointPolicy", () => {
  it("throws with all detected risky primitives", () => {
    expect(() =>
      assertPackedEntrypointPolicy(
        'eval("1"); import("node:vm"); Bun.spawn(["sh"]); Bun.spawnSync(["sh"]); Bun.$`rm -rf ${path}`;',
      ),
    ).toThrow(
      "Packed dist/index.js must not contain risky runtime primitives: eval, vm import, Bun.spawn, Bun.spawnSync, Bun shell",
    );
  });
});
