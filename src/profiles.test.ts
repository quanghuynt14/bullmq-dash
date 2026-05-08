import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandEnvRefs,
  formatRedisUrl,
  loadProfile,
  parseRedisUrl,
  resolveConfigPath,
} from "./profiles.js";

const mockExit = (code?: number) => {
  throw new Error(`process.exit(${code})`);
};

function silenceErrors() {
  const exitSpy = spyOn(process, "exit").mockImplementation(mockExit as never);
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    restore() {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe("resolveConfigPath", () => {
  it("prefers an explicit path over everything else", () => {
    expect(
      resolveConfigPath("/tmp/explicit.json", {
        BULLMQ_DASH_CONFIG: "/tmp/env.json",
        XDG_CONFIG_HOME: "/tmp/xdg",
      }),
    ).toBe("/tmp/explicit.json");
  });

  it("falls back to BULLMQ_DASH_CONFIG when no explicit path", () => {
    expect(
      resolveConfigPath(undefined, {
        BULLMQ_DASH_CONFIG: "/tmp/env.json",
        XDG_CONFIG_HOME: "/tmp/xdg",
      }),
    ).toBe("/tmp/env.json");
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/bullmq-dash/config.json",
    );
  });

  it("defaults to ~/.config/bullmq-dash/config.json", () => {
    const path = resolveConfigPath(undefined, {});
    expect(path.endsWith("/.config/bullmq-dash/config.json")).toBe(true);
  });
});

describe("expandEnvRefs", () => {
  it("returns scalars unchanged when no env ref present", () => {
    expect(expandEnvRefs("plain", {})).toBe("plain");
    expect(expandEnvRefs(42, {})).toBe(42);
    expect(expandEnvRefs(true, {})).toBe(true);
  });

  it("expands a whole-string ${VAR} reference", () => {
    expect(expandEnvRefs("${MY_PASSWORD}", { MY_PASSWORD: "s3cret" })).toBe("s3cret");
  });

  it("walks nested objects", () => {
    expect(
      expandEnvRefs(
        { redis: { password: "${REDIS_PASS}", host: "localhost" } },
        { REDIS_PASS: "hunter2" },
      ),
    ).toEqual({ redis: { password: "hunter2", host: "localhost" } });
  });

  it("walks arrays", () => {
    expect(expandEnvRefs(["${A}", "literal", "${B}"], { A: "alpha", B: "beta" })).toEqual([
      "alpha",
      "literal",
      "beta",
    ]);
  });

  it("throws when an env var referenced in the profile is missing", () => {
    // Hard-fail so secrets never silently resolve to empty/undefined and connect anonymously.
    expect(() => expandEnvRefs("${MISSING}", {})).toThrow(/MISSING/);
  });

  it("does not partial-substitute (only whole-string ${VAR} matches)", () => {
    expect(expandEnvRefs("prefix-${VAR}-suffix", { VAR: "x" })).toBe("prefix-${VAR}-suffix");
  });
});

describe("loadProfile", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bullmq-dash-profiles-"));
    configPath = join(tmpDir, "config.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no config file exists and no profile requested", () => {
    // Backward compat: missing config is silently ignored unless caller asked for it.
    expect(loadProfile({ configPath: undefined, env: {} })).toBeNull();
  });

  it("exits with code 2 when --config points at a missing file", () => {
    const safety = silenceErrors();
    expect(() => loadProfile({ configPath: "/no/such/file.json" })).toThrow("process.exit(2)");
    safety.restore();
  });

  it("exits with code 2 when --profile requested but config file missing", () => {
    const safety = silenceErrors();
    // Use an unlikely-to-exist path under the tmp dir so HOME doesn't accidentally resolve.
    const missing = join(tmpDir, "nope.json");
    expect(() =>
      loadProfile({ configPath: missing, profileName: "prod" }),
    ).toThrow("process.exit(2)");
    safety.restore();
  });

  it("exits with code 2 on malformed JSON", () => {
    writeFileSync(configPath, "{ this is not json");
    const safety = silenceErrors();
    expect(() => loadProfile({ configPath })).toThrow("process.exit(2)");
    safety.restore();
  });

  it("exits with code 2 on schema-invalid contents", () => {
    // Strict schema rejects unknown redis fields — the URL-only redesign
    // means anything other than `url` (e.g. legacy `port`) trips this.
    writeFileSync(
      configPath,
      JSON.stringify({ profiles: { local: { redis: { port: 6379 } } } }),
    );
    const safety = silenceErrors();
    expect(() => loadProfile({ configPath, profileName: "local" })).toThrow("process.exit(2)");
    safety.restore();
  });

  it("exits with code 2 when the named profile doesn't exist", () => {
    writeFileSync(configPath, JSON.stringify({ profiles: { local: {} } }));
    const safety = silenceErrors();
    expect(() => loadProfile({ configPath, profileName: "prod" })).toThrow("process.exit(2)");
    safety.restore();
  });

  it("returns null when file has no defaultProfile and no --profile given", () => {
    writeFileSync(configPath, JSON.stringify({ profiles: { local: {} } }));
    expect(loadProfile({ configPath })).toBeNull();
  });

  it("falls back to defaultProfile when --profile not given", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "local",
        profiles: { local: { redis: { url: "redis://localhost:6379" } } },
      }),
    );
    const result = loadProfile({ configPath });
    expect(result?.name).toBe("local");
    expect(result?.profile.redis?.url).toBe("redis://localhost:6379");
  });

  it("--profile overrides defaultProfile", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "local",
        profiles: {
          local: { redis: { url: "redis://localhost" } },
          prod: { redis: { url: "redis://prod.example.com" } },
        },
      }),
    );
    const result = loadProfile({ configPath, profileName: "prod" });
    expect(result?.name).toBe("prod");
    expect(result?.profile.redis?.url).toBe("redis://prod.example.com");
  });

  it("expands env-var references inside the URL", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        profiles: { prod: { redis: { url: "${REDIS_URL}" } } },
      }),
    );
    const result = loadProfile({
      configPath,
      profileName: "prod",
      env: { REDIS_URL: "redis://:hunter2@redis.example.com:6379/0" },
    });
    expect(result?.profile.redis?.url).toBe("redis://:hunter2@redis.example.com:6379/0");
  });

  it("exits with code 2 when an env var referenced by the profile is missing", () => {
    // The interpolation rule is whole-string only (see expandEnvRefs tests),
    // so for URLs the realistic shape is `"url": "${REDIS_URL}"`.
    writeFileSync(
      configPath,
      JSON.stringify({
        profiles: { prod: { redis: { url: "${MISSING_REDIS_URL}" } } },
      }),
    );
    const safety = silenceErrors();
    expect(() =>
      loadProfile({ configPath, profileName: "prod", env: {} }),
    ).toThrow("process.exit(2)");
    safety.restore();
  });

  it("exits with code 2 when a profile uses an unknown redis field", () => {
    // Strict schema: discrete fields like host/port/password were removed in
    // the URL-only redesign, so anything other than `url` is a hard error.
    writeFileSync(
      configPath,
      JSON.stringify({
        profiles: { legacy: { redis: { host: "localhost", port: 6379 } } },
      }),
    );
    const safety = silenceErrors();
    expect(() => loadProfile({ configPath, profileName: "legacy" })).toThrow("process.exit(2)");
    safety.restore();
  });

  it("accepts a profile with just redis.url", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        profiles: { prod: { redis: { url: "rediss://user:pass@host.example.com:6380/2" } } },
      }),
    );
    const result = loadProfile({ configPath, profileName: "prod" });
    expect(result?.profile.redis?.url).toBe("rediss://user:pass@host.example.com:6380/2");
  });
});

describe("parseRedisUrl", () => {
  it("parses a minimal redis:// URL with defaults", () => {
    expect(parseRedisUrl("redis://localhost")).toEqual({
      host: "localhost",
      port: 6379,
      username: undefined,
      password: undefined,
      db: undefined,
      tls: false,
    });
  });

  it("parses host + custom port", () => {
    expect(parseRedisUrl("redis://redis.example.com:6380")).toMatchObject({
      host: "redis.example.com",
      port: 6380,
    });
  });

  it("parses username + password", () => {
    expect(parseRedisUrl("redis://alice:s3cret@host:6379")).toMatchObject({
      username: "alice",
      password: "s3cret",
    });
  });

  it("parses password-only (no username)", () => {
    expect(parseRedisUrl("redis://:onlypass@host:6379")).toMatchObject({
      username: undefined,
      password: "onlypass",
    });
  });

  it("decodes percent-encoded passwords", () => {
    // Real-world: passwords often contain @, :, /, etc., which must be encoded
    // in URLs. We must decode so the value sent to Redis matches the literal.
    expect(parseRedisUrl("redis://:p%40ss%2Fword@host")).toMatchObject({
      password: "p@ss/word",
    });
  });

  it("rejects malformed percent-encoding with a clear message", () => {
    // `%bad` is invalid hex. Without the explicit catch, decodeURIComponent
    // throws the cryptic built-in `URIError: URI malformed`.
    expect(() => parseRedisUrl("redis://:%bad@host")).toThrow(
      /Invalid percent-encoding in URL password/,
    );
    expect(() => parseRedisUrl("redis://%zz@host")).toThrow(
      /Invalid percent-encoding in URL username/,
    );
  });

  it("parses db number from the path", () => {
    expect(parseRedisUrl("redis://host:6379/3")).toMatchObject({ db: 3 });
  });

  it("rejects a non-numeric db path", () => {
    expect(() => parseRedisUrl("redis://host/notadb")).toThrow(/non-negative integer/);
  });

  it("rejects unsupported schemes", () => {
    expect(() => parseRedisUrl("http://host")).toThrow(/Unsupported scheme/);
  });

  it("rejects malformed URLs", () => {
    expect(() => parseRedisUrl("not a url")).toThrow(/valid URL/);
  });

  it("redacts userinfo from error messages on malformed URLs", () => {
    // Stderr from a CLI parse failure can flow into CI logs, bug reports, or
    // screenshares — the password should never appear there.
    try {
      parseRedisUrl("redis://user:hunter2@bad host"); // space → URL parse fails
      throw new Error("expected parse to throw");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain("hunter2");
      expect(msg).toContain("[REDACTED]");
    }
  });

  it("redacts userinfo when host is missing", () => {
    // `redis://:pass@/0` parses but has empty hostname — must not echo the password.
    try {
      parseRedisUrl("redis://user:hunter2@/0");
      throw new Error("expected parse to throw");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain("hunter2");
    }
  });

  it("rejects URLs with query strings (silent drop would mask intent)", () => {
    // `?ssl=true` is the common footgun — silently dropped, the user thinks they
    // have TLS but the connection is plaintext with credentials over the wire.
    expect(() => parseRedisUrl("redis://host/0?ssl=true")).toThrow(
      /Query parameters and fragments are not supported/,
    );
  });

  it("rejects URLs with fragments", () => {
    expect(() => parseRedisUrl("redis://host/0#frag")).toThrow(
      /Query parameters and fragments are not supported/,
    );
  });

  it("flips tls=true for rediss://", () => {
    expect(parseRedisUrl("rediss://host")).toMatchObject({ tls: true });
  });

  it("requires a host", () => {
    // Surprisingly, `new URL("redis://")` throws — but `redis:///0` parses with
    // empty hostname. Belt-and-suspenders: enforce a host explicitly.
    expect(() => parseRedisUrl("redis:///0")).toThrow(/Missing host/);
  });
});

describe("formatRedisUrl", () => {
  it("formats a minimal redis URL", () => {
    expect(formatRedisUrl({ host: "localhost", port: 6379 })).toBe("redis://localhost");
  });

  it("includes port when non-default", () => {
    expect(formatRedisUrl({ host: "host", port: 6380 })).toBe("redis://host:6380");
  });

  it("includes db when non-zero", () => {
    expect(formatRedisUrl({ host: "host", port: 6379, db: 3 })).toBe("redis://host/3");
  });

  it("uses rediss:// when tls=true", () => {
    expect(formatRedisUrl({ host: "host", port: 6379, tls: true })).toBe("rediss://host");
  });

  it("encodes special characters in passwords", () => {
    // round-trip safety: a password with @/: would break the URL otherwise
    expect(formatRedisUrl({ host: "host", port: 6379, password: "p@ss/word" })).toBe(
      "redis://:p%40ss%2Fword@host",
    );
  });

  it("round-trips with parseRedisUrl", () => {
    const original = "rediss://alice:p%40ss@redis.example.com:6380/2";
    const parsed = parseRedisUrl(original);
    const reformatted = formatRedisUrl(parsed);
    // Re-parse to compare structurally (default-port elision means string
    // identity isn't guaranteed, but the resolved fields must match).
    expect(parseRedisUrl(reformatted)).toEqual(parsed);
  });
});
