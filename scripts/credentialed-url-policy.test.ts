import { describe, expect, it } from "bun:test";
import {
  assertNoCredentialedRedisUrls,
  getCredentialedUrlPolicyViolations,
} from "./credentialed-url-policy.js";

describe("getCredentialedUrlPolicyViolations", () => {
  it("allows non-credentialed Redis URL examples", () => {
    expect(
      getCredentialedUrlPolicyViolations({
        "package/README.md": "Use redis://redis.example.com:6379 or rediss://redis.example.com",
      }),
    ).toEqual([]);
  });

  it("rejects credentialed Redis URL examples", () => {
    expect(
      getCredentialedUrlPolicyViolations({
        "package/README.md": "redis://user:pass@redis.example.com:6379/0",
        "package/dist/index.js": "rediss://:p%40ss@redis.example.com:6379",
      }),
    ).toEqual([{ artifact: "package/README.md" }, { artifact: "package/dist/index.js" }]);
  });
});

describe("assertNoCredentialedRedisUrls", () => {
  it("throws with all affected artifacts", () => {
    expect(() =>
      assertNoCredentialedRedisUrls({
        "package/README.md": "redis://user:pass@redis.example.com:6379/0",
      }),
    ).toThrow(
      "Packed artifacts must not contain credentialed Redis URL examples: package/README.md",
    );
  });
});
