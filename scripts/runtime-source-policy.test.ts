import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRuntimeCapabilityEvidence,
  assertNoRemovedDependencyReferences,
  containsRemovedDependencyReference,
  formatRuntimeCapabilityEvidence,
  getRuntimeCapabilityEvidence,
  getRuntimePrimitivePolicyViolations,
  getRuntimeSourcePolicyViolations,
} from "./runtime-source-policy.js";

function withTempSource(files: Record<string, string>, test: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bullmq-dash-source-policy-"));

  try {
    for (const [file, source] of Object.entries(files)) {
      const path = join(directory, file);
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      writeFileSync(path, source);
    }

    test(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("getRuntimeSourcePolicyViolations", () => {
  it("allows runtime source without removed direct dependency imports", () => {
    withTempSource(
      {
        "index.ts": 'import { Queue } from "bullmq";\nconsole.log(Queue);\n',
      },
      (directory) => {
        expect(getRuntimeSourcePolicyViolations(directory)).toEqual([]);
      },
    );
  });

  it("rejects static, side-effect, dynamic, require, and subpath imports", () => {
    withTempSource(
      {
        "static.ts": 'import { z } from "zod";\n',
        "side-effect.ts": 'import "ioredis";\n',
        "dynamic.ts": 'await import("zod/v4");\n',
        "nested/require.ts": 'const Redis = require("ioredis/built/Redis");\n',
      },
      (directory) => {
        const violations = getRuntimeSourcePolicyViolations(directory);

        expect(violations).toHaveLength(4);
        expect(violations.some((path) => path.endsWith("static.ts"))).toBe(true);
        expect(violations.some((path) => path.endsWith("side-effect.ts"))).toBe(true);
        expect(violations.some((path) => path.endsWith("dynamic.ts"))).toBe(true);
        expect(violations.some((path) => path.endsWith("nested/require.ts"))).toBe(true);
      },
    );
  });
});

describe("getRuntimePrimitivePolicyViolations", () => {
  it("allows ordinary runtime source", () => {
    withTempSource(
      {
        "redis.ts": 'import { RedisConnection } from "bullmq";\nconsole.log(RedisConnection);\n',
      },
      (directory) => {
        expect(getRuntimePrimitivePolicyViolations(directory)).toEqual([]);
      },
    );
  });

  it("rejects shell and dynamic-code primitives in runtime source", () => {
    withTempSource(
      {
        "eval.ts": 'eval("1 + 1");\n',
        "function.ts": 'const f = new Function("return process.env");\n',
        "shell.ts": 'Bun.spawn(["sh", "-c", "echo unsafe"]);\n',
        "nested/vm.ts": 'import vm from "node:vm";\nconsole.log(vm);\n',
      },
      (directory) => {
        const violations = getRuntimePrimitivePolicyViolations(directory);

        expect(violations).toHaveLength(4);
        expect(violations.some((violation) => violation.endsWith("eval.ts: eval"))).toBe(true);
        expect(
          violations.some((violation) => violation.endsWith("function.ts: Function constructor")),
        ).toBe(true);
        expect(violations.some((violation) => violation.endsWith("shell.ts: Bun.spawn"))).toBe(
          true,
        );
        expect(violations.some((violation) => violation.endsWith("nested/vm.ts: vm import"))).toBe(
          true,
        );
      },
    );
  });
});

describe("getRuntimeCapabilityEvidence", () => {
  it("maps expected Socket capability alerts to runtime behavior", () => {
    const evidence = getRuntimeCapabilityEvidence({
      "src/index.ts":
        'const env = process.env;\nconst raw = readFileSync(path, "utf-8");\nconst url = new URL(input);\n',
      "src/data/redis.ts": 'const redis = new RedisConnection({ host: "localhost" });\n',
    });

    expect(evidence).toEqual({
      redisNetwork: true,
      profileEnvironment: true,
      profileFileRead: true,
      redisUrlParsing: true,
    });
    expect(formatRuntimeCapabilityEvidence(evidence)).toBe(
      "Redis network access, profile environment interpolation, profile config file reads, Redis URL parsing",
    );
  });

  it("accepts no Redis runtime capabilities for the clean base package", () => {
    expect(() =>
      assertRuntimeCapabilityEvidence({
        redisNetwork: false,
        profileEnvironment: false,
        profileFileRead: false,
        redisUrlParsing: false,
      }),
    ).not.toThrow();
  });

  it("rejects capabilities in the clean base package", () => {
    expect(() =>
      assertRuntimeCapabilityEvidence({
        redisNetwork: true,
        profileEnvironment: true,
        profileFileRead: true,
        redisUrlParsing: true,
      }),
    ).toThrow(
      "Runtime capability policy found non-clean base package capabilities: Redis network access, profile environment interpolation, profile config file reads, Redis URL parsing",
    );
  });
});

describe("containsRemovedDependencyReference", () => {
  it("uses the same matcher for built artifacts and source files", () => {
    expect(containsRemovedDependencyReference('const mod = await import("zod/v4");')).toBe(true);
    expect(containsRemovedDependencyReference('const mod = await import("bullmq");')).toBe(false);
  });
});

describe("assertNoRemovedDependencyReferences", () => {
  it("throws with the provided artifact label", () => {
    expect(() =>
      assertNoRemovedDependencyReferences(
        'const Redis = require("ioredis");',
        "Packed dist/index.js",
      ),
    ).toThrow("Packed dist/index.js must not directly import removed dependencies");
  });
});
