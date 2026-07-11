import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import {
  describeRedisTarget,
  parseRedisInfo,
  runDoctor,
  type DoctorProbe,
  type DoctorReport,
} from "./doctor.js";
import { formatDoctorReport } from "./formatters.js";
import { parseRedisUrl } from "./profiles.js";

// ── Test helpers ────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bullmq-dash-doctor-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Env with config discovery pinned inside the temp dir so tests never read
 * the developer's real ~/.config/bullmq-dash/config.json.
 */
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: join(tempDir, "xdg"), ...extra };
}

function writeConfig(contents: string): string {
  const path = join(tempDir, "config.json");
  writeFileSync(path, contents);
  return path;
}

interface FakeProbeState {
  configs: Config[];
  closed: number;
}

function fakeProbeFactory(overrides: Partial<DoctorProbe> = {}): {
  factory: (config: Config) => DoctorProbe;
  state: FakeProbeState;
} {
  const state: FakeProbeState = { configs: [], closed: 0 };
  const factory = (config: Config): DoctorProbe => {
    state.configs.push(config);
    return {
      ping: async () => {},
      serverInfo: async () => ({ redis_version: "7.2.4", redis_mode: "standalone" }),
      discoverQueues: async () => ["email", "payments"],
      close: async () => {
        state.closed++;
      },
      ...overrides,
    };
  };
  return { factory, state };
}

function check(report: DoctorReport, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`check '${name}' missing from report`);
  return found;
}

// ── parseRedisInfo ──────────────────────────────────────────────────────

describe("parseRedisInfo", () => {
  it("parses key:value lines and skips comments", () => {
    const parsed = parseRedisInfo(
      "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n\r\nos:Linux 6.1:extra\r\n",
    );
    expect(parsed.redis_version).toBe("7.2.4");
    expect(parsed.redis_mode).toBe("standalone");
    // Value may itself contain colons; only the first splits.
    expect(parsed.os).toBe("Linux 6.1:extra");
  });
});

// ── describeRedisTarget ─────────────────────────────────────────────────

describe("describeRedisTarget", () => {
  it("renders host, port, db, and TLS scheme without credentials", () => {
    const parts = parseRedisUrl("rediss://user:s3cret@redis.example.com:6380/2");
    const target = describeRedisTarget(parts);
    expect(target).toBe("rediss://redis.example.com:6380/2 (auth configured)");
    expect(target).not.toContain("s3cret");
    expect(target).not.toContain("user");
  });

  it("omits the auth marker when no credentials are set", () => {
    expect(describeRedisTarget(parseRedisUrl("redis://localhost:6379"))).toBe(
      "redis://localhost:6379",
    );
  });
});

// ── runDoctor ───────────────────────────────────────────────────────────

describe("runDoctor", () => {
  it("passes all checks with a valid URL and reachable Redis", async () => {
    const { factory, state } = fakeProbeFactory();
    const report = await runDoctor({
      redisUrl: "redis://localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });

    expect(report.ok).toBe(true);
    expect(check(report, "connection").status).toBe("ok");
    expect(check(report, "connection").detail).toContain("from --redis-url");
    expect(check(report, "redis-ping").status).toBe("ok");
    expect(check(report, "redis-server").detail).toBe("Redis 7.2.4 (standalone)");
    expect(check(report, "queue-discovery").status).toBe("ok");
    expect(check(report, "queue-discovery").detail).toContain("email, payments");
    expect(state.closed).toBe(1);
  });

  it("never includes credentials anywhere in the report", async () => {
    const { factory } = fakeProbeFactory();
    const report = await runDoctor({
      redisUrl: "redis://user:supersecret@localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("supersecret");
    expect(check(report, "connection").detail).toContain("(auth configured)");
  });

  it("fails the connection check when no source is configured", async () => {
    const { factory, state } = fakeProbeFactory();
    const report = await runDoctor({ env: isolatedEnv(), probeFactory: factory });

    expect(report.ok).toBe(false);
    expect(check(report, "config-file").status).toBe("ok");
    expect(check(report, "profile").status).toBe("skip");
    expect(check(report, "connection").status).toBe("fail");
    expect(check(report, "redis-ping").status).toBe("skip");
    expect(check(report, "redis-server").status).toBe("skip");
    expect(check(report, "queue-discovery").status).toBe("skip");
    expect(state.configs.length).toBe(0);
  });

  it("fails redis-ping and skips downstream checks when the server is unreachable", async () => {
    const { factory, state } = fakeProbeFactory({
      ping: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    });
    const report = await runDoctor({
      redisUrl: "redis://localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });

    expect(report.ok).toBe(false);
    expect(check(report, "redis-ping").status).toBe("fail");
    expect(check(report, "redis-ping").hint).toContain("ECONNREFUSED");
    expect(check(report, "redis-server").status).toBe("skip");
    expect(check(report, "queue-discovery").status).toBe("skip");
    expect(state.closed).toBe(1);
  });

  it("treats an empty queue discovery as a warning, not a failure", async () => {
    const { factory } = fakeProbeFactory({ discoverQueues: async () => [] });
    const report = await runDoctor({
      redisUrl: "redis://localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });

    expect(report.ok).toBe(true);
    expect(check(report, "queue-discovery").status).toBe("warn");
    expect(check(report, "queue-discovery").hint).toContain("--prefix");
  });

  it("treats a blocked INFO command as a warning, not a failure", async () => {
    const { factory } = fakeProbeFactory({
      serverInfo: async () => {
        throw new Error("NOPERM this user has no permissions");
      },
    });
    const report = await runDoctor({
      redisUrl: "redis://localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });

    expect(report.ok).toBe(true);
    expect(check(report, "redis-server").status).toBe("warn");
    expect(check(report, "queue-discovery").status).toBe("ok");
  });

  it("fails config-file on invalid JSON but keeps diagnosing the connection", async () => {
    const path = writeConfig("{ not json");
    const { factory } = fakeProbeFactory();
    const report = await runDoctor({
      configPath: path,
      redisUrl: "redis://localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });

    expect(report.ok).toBe(false);
    expect(check(report, "config-file").status).toBe("fail");
    expect(check(report, "config-file").detail).toContain("not valid JSON");
    expect(check(report, "redis-ping").status).toBe("ok");
  });

  it("fails config-file on schema violations with the validation errors as hint", async () => {
    const path = writeConfig(JSON.stringify({ profiles: { local: { host: "nope" } } }));
    const report = await runDoctor({ configPath: path, env: isolatedEnv() });

    expect(check(report, "config-file").status).toBe("fail");
    expect(check(report, "config-file").hint).toContain("unknown key 'host'");
  });

  it("fails config-file when an explicit --config path does not exist", async () => {
    const report = await runDoctor({
      configPath: join(tempDir, "missing.json"),
      env: isolatedEnv(),
    });
    expect(check(report, "config-file").status).toBe("fail");
    expect(check(report, "config-file").detail).toContain("not found");
  });

  it("resolves the connection from a profile and applies its prefix", async () => {
    const path = writeConfig(
      JSON.stringify({
        defaultProfile: "local",
        profiles: {
          local: { redis: { url: "redis://localhost:6390/1" }, prefix: "custom" },
        },
      }),
    );
    const { factory, state } = fakeProbeFactory();
    const report = await runDoctor({ configPath: path, env: isolatedEnv(), probeFactory: factory });

    expect(report.ok).toBe(true);
    expect(check(report, "profile").detail).toContain("'local'");
    expect(check(report, "profile").detail).toContain("defaultProfile");
    expect(check(report, "connection").detail).toContain("from profile 'local'");
    expect(state.configs[0]?.redis.port).toBe(6390);
    expect(state.configs[0]?.redis.db).toBe(1);
    expect(state.configs[0]?.prefix).toBe("custom");
  });

  it("fails the profile check when an env var reference is unset", async () => {
    const path = writeConfig(
      JSON.stringify({ profiles: { prod: { redis: { url: "${DOCTOR_TEST_UNSET_URL}" } } } }),
    );
    const report = await runDoctor({
      configPath: path,
      profileName: "prod",
      env: isolatedEnv(),
    });

    expect(report.ok).toBe(false);
    expect(check(report, "profile").status).toBe("fail");
    expect(check(report, "profile").hint).toContain("DOCTOR_TEST_UNSET_URL");
    expect(check(report, "connection").status).toBe("fail");
  });

  it("fails the profile check when the named profile does not exist", async () => {
    const path = writeConfig(
      JSON.stringify({ profiles: { local: { redis: { url: "redis://localhost" } } } }),
    );
    const report = await runDoctor({ configPath: path, profileName: "prod", env: isolatedEnv() });

    expect(check(report, "profile").status).toBe("fail");
    expect(check(report, "profile").hint).toContain("local");
  });

  it("prefers --redis-url over the profile URL", async () => {
    const path = writeConfig(
      JSON.stringify({
        defaultProfile: "local",
        profiles: { local: { redis: { url: "redis://profile-host:7000" } } },
      }),
    );
    const { factory, state } = fakeProbeFactory();
    const report = await runDoctor({
      configPath: path,
      redisUrl: "redis://cli-host:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });

    expect(check(report, "connection").detail).toContain("cli-host");
    expect(check(report, "connection").detail).toContain("from --redis-url");
    expect(state.configs[0]?.redis.host).toBe("cli-host");
  });
});

// ── formatDoctorReport ──────────────────────────────────────────────────

describe("formatDoctorReport", () => {
  it("renders a checklist with status symbols, hints, and a summary line", async () => {
    const { factory } = fakeProbeFactory({ discoverQueues: async () => [] });
    const report = await runDoctor({
      redisUrl: "redis://localhost:6379",
      env: isolatedEnv(),
      probeFactory: factory,
    });
    const text = formatDoctorReport(report);

    expect(text).toContain("✓ redis-ping");
    expect(text).toContain("! queue-discovery");
    expect(text).toContain("hint:");
    expect(text).toMatch(/\d+ ok, \d+ warning\(s\), \d+ failed, \d+ skipped/);
    expect(text).not.toContain("Some checks failed");
  });

  it("flags failing reports in the summary", async () => {
    const report = await runDoctor({ env: isolatedEnv() });
    const text = formatDoctorReport(report);
    expect(text).toContain("✗ connection");
    expect(text).toContain("Some checks failed");
  });
});
