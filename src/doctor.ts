import { existsSync, readFileSync } from "node:fs";
import type { CliArgs } from "./cli.js";
import { getVersionText } from "./cli.js";
import type { Config } from "./config.js";
import { closeContext, createContext } from "./context.js";
import { discoverQueueNames } from "./data/queues.js";
import { formatDoctorReport } from "./formatters.js";
import {
  expandEnvRefs,
  parseRedisUrl,
  resolveConfigPath,
  validateProfilesFile,
  type ParsedRedisUrl,
  type Profile,
  type ProfilesFile,
} from "./profiles.js";

// ── Report shape ────────────────────────────────────────────────────────

export type DoctorCheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  timestamp: string;
  command: "doctor";
  version: string;
  runtime: string;
  checks: DoctorCheck[];
  /** True when no check failed. Warnings and skips do not fail the report. */
  ok: boolean;
}

// ── Redis probe (injectable for tests) ──────────────────────────────────

/**
 * The live-Redis surface doctor exercises. Factored out so tests can fake
 * connectivity outcomes without a Redis server.
 */
export interface DoctorProbe {
  ping(): Promise<void>;
  /** Parsed key/value pairs from `INFO server`. */
  serverInfo(): Promise<Record<string, string>>;
  discoverQueues(): Promise<string[]>;
  close(): Promise<void>;
}

export type DoctorProbeFactory = (config: Config) => DoctorProbe;

/** Parse Redis INFO output ("key:value" lines, "#" comments) into a map. */
export function parseRedisInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function createContextProbe(config: Config): DoctorProbe {
  // In-memory SQLite: doctor is a diagnostic pass and must not touch the
  // observation cache the real modes maintain.
  const ctx = createContext(config, { dbPath: ":memory:" });
  return {
    async ping() {
      await ctx.redis.ping();
    },
    async serverInfo() {
      return parseRedisInfo(await ctx.redis.info("server"));
    },
    async discoverQueues() {
      return discoverQueueNames(ctx);
    },
    async close() {
      await closeContext(ctx);
    },
  };
}

// ── Check runner ────────────────────────────────────────────────────────

export interface DoctorOptions {
  redisUrl?: string;
  profileName?: string;
  configPath?: string;
  prefix?: string;
  env?: NodeJS.ProcessEnv;
  probeFactory?: DoctorProbeFactory;
}

const DISCOVERY_SAMPLE_SIZE = 5;

function describeConfigSource(opts: DoctorOptions, env: NodeJS.ProcessEnv): string {
  if (opts.configPath) return "--config";
  if (env.BULLMQ_DASH_CONFIG) return "$BULLMQ_DASH_CONFIG";
  if (env.XDG_CONFIG_HOME) return "$XDG_CONFIG_HOME";
  return "default path";
}

/** Credential-free display form of a parsed Redis URL. */
export function describeRedisTarget(parts: ParsedRedisUrl): string {
  const scheme = parts.tls ? "rediss" : "redis";
  const db = parts.db !== undefined ? `/${parts.db}` : "";
  const auth = parts.username || parts.password ? " (auth configured)" : "";
  return `${scheme}://${parts.host}:${parts.port}${db}${auth}`;
}

interface ConfigFileInspection {
  check: DoctorCheck;
  file: ProfilesFile | null;
}

function inspectConfigFile(opts: DoctorOptions, env: NodeJS.ProcessEnv): ConfigFileInspection {
  const path = resolveConfigPath(opts.configPath, env);
  const source = describeConfigSource(opts, env);
  const explicit = !!opts.configPath || !!env.BULLMQ_DASH_CONFIG;

  if (!existsSync(path)) {
    if (explicit || opts.profileName) {
      return {
        check: {
          name: "config-file",
          status: "fail",
          detail: `Config file not found: ${path} (from ${source})`,
          hint: explicit
            ? "Check the path passed to --config or $BULLMQ_DASH_CONFIG."
            : `--profile requires a config file. Create one at ${path} or pass --config <path>.`,
        },
        file: null,
      };
    }
    return {
      check: {
        name: "config-file",
        status: "ok",
        detail: `No config file at ${path} — optional, profiles disabled`,
      },
      file: null,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return {
      check: {
        name: "config-file",
        status: "fail",
        detail: `Config file is not valid JSON: ${path}`,
        hint: error instanceof Error ? error.message : String(error),
      },
      file: null,
    };
  }

  const parsed = validateProfilesFile(raw);
  if (Array.isArray(parsed)) {
    return {
      check: {
        name: "config-file",
        status: "fail",
        detail: `Invalid config file: ${path}`,
        hint: parsed.join("; "),
      },
      file: null,
    };
  }

  const names = Object.keys(parsed.profiles);
  const profilesSummary =
    names.length > 0 ? `profiles: ${names.join(", ")}` : "no profiles defined";
  const defaultSuffix = parsed.defaultProfile ? ` (default: ${parsed.defaultProfile})` : "";
  return {
    check: {
      name: "config-file",
      status: "ok",
      detail: `${path} — ${profilesSummary}${defaultSuffix}`,
    },
    file: parsed,
  };
}

interface ProfileInspection {
  check: DoctorCheck;
  profile: Profile | null;
  profileName: string | null;
}

function inspectProfile(
  opts: DoctorOptions,
  env: NodeJS.ProcessEnv,
  file: ProfilesFile | null,
): ProfileInspection {
  const none: ProfileInspection = {
    check: skipCheck("profile", ""),
    profile: null,
    profileName: null,
  };

  if (!file) {
    if (opts.profileName) {
      return {
        ...none,
        check: {
          name: "profile",
          status: "fail",
          detail: `Profile '${opts.profileName}' requested but no config file was loaded`,
          hint: "Fix the config-file check first.",
        },
      };
    }
    return { ...none, check: skipCheck("profile", "no config file loaded, no profile to select") };
  }

  const name = opts.profileName ?? file.defaultProfile;
  if (!name) {
    return { ...none, check: skipCheck("profile", "no --profile and no defaultProfile set") };
  }

  const profile = file.profiles[name];
  if (!profile) {
    const available = Object.keys(file.profiles);
    return {
      ...none,
      check: {
        name: "profile",
        status: "fail",
        detail: `Profile '${name}' not found`,
        hint:
          available.length > 0
            ? `Available profiles: ${available.join(", ")}`
            : "No profiles are defined in the config file.",
      },
    };
  }

  try {
    const expanded = expandEnvRefs(profile, env);
    const via = opts.profileName ? "--profile" : "defaultProfile";
    return {
      check: { name: "profile", status: "ok", detail: `Using profile '${name}' (via ${via})` },
      profile: expanded,
      profileName: name,
    };
  } catch (error) {
    return {
      ...none,
      check: {
        name: "profile",
        status: "fail",
        detail: `Failed to resolve env vars in profile '${name}'`,
        hint: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function skipCheck(name: string, reason: string): DoctorCheck {
  return { name, status: "skip", detail: reason };
}

function buildProbeConfig(parts: ParsedRedisUrl, prefix: string): Config {
  const config: Config = {
    redis: { host: parts.host, port: parts.port, db: parts.db ?? 0 },
    pollInterval: 3000,
    prefix,
    cacheTtlMs: 24 * 60 * 60 * 1000,
  };
  if (parts.username !== undefined) config.redis.username = parts.username;
  if (parts.password !== undefined) config.redis.password = parts.password;
  if (parts.tls !== undefined) config.redis.tls = parts.tls;
  // No queueNames: doctor always scans so it reports what Redis actually
  // contains, even when --queues or a profile pins the monitored set.
  return config;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];

  // 1. Config file resolution + schema
  const { check: configCheck, file } = inspectConfigFile(opts, env);
  checks.push(configCheck);

  // 2. Profile selection + env-var expansion
  const { check: profileCheck, profile, profileName } = inspectProfile(opts, env, file);
  checks.push(profileCheck);

  // 3. Connection source + URL shape
  const url = opts.redisUrl ?? profile?.redis?.url;
  let parts: ParsedRedisUrl | null = null;
  if (!url) {
    checks.push({
      name: "connection",
      status: "fail",
      detail: "No Redis connection source",
      hint: "Pass --redis-url <url>, or configure a profile with redis.url.",
    });
  } else {
    const source = opts.redisUrl ? "--redis-url" : `profile '${profileName}'`;
    try {
      parts = parseRedisUrl(url);
      checks.push({
        name: "connection",
        status: "ok",
        detail: `${describeRedisTarget(parts)} (from ${source})`,
      });
    } catch (error) {
      checks.push({
        name: "connection",
        status: "fail",
        detail: `Invalid Redis URL from ${source}`,
        hint: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 4–6. Live checks against Redis
  if (!parts) {
    checks.push(
      skipCheck("redis-ping", "no valid connection source"),
      skipCheck("redis-server", "no valid connection source"),
      skipCheck("queue-discovery", "no valid connection source"),
    );
  } else {
    const prefix = opts.prefix ?? profile?.prefix ?? "bull";
    const probe = (opts.probeFactory ?? createContextProbe)(buildProbeConfig(parts, prefix));
    try {
      let connected = false;
      const started = performance.now();
      try {
        await probe.ping();
        connected = true;
        checks.push({
          name: "redis-ping",
          status: "ok",
          detail: `PING ok in ${Math.max(1, Math.round(performance.now() - started))}ms`,
        });
      } catch (error) {
        checks.push({
          name: "redis-ping",
          status: "fail",
          detail: "Redis connection failed",
          hint: error instanceof Error ? error.message : String(error),
        });
      }

      if (!connected) {
        checks.push(
          skipCheck("redis-server", "connection failed"),
          skipCheck("queue-discovery", "connection failed"),
        );
      } else {
        try {
          const info = await probe.serverInfo();
          const version = info.redis_version ?? "unknown version";
          const mode = info.redis_mode ? ` (${info.redis_mode})` : "";
          checks.push({ name: "redis-server", status: "ok", detail: `Redis ${version}${mode}` });
        } catch (error) {
          // INFO can be blocked by ACLs on managed Redis; that alone isn't a failure.
          checks.push({
            name: "redis-server",
            status: "warn",
            detail: "Could not read INFO from server",
            hint: error instanceof Error ? error.message : String(error),
          });
        }

        try {
          const names = await probe.discoverQueues();
          if (names.length === 0) {
            checks.push({
              name: "queue-discovery",
              status: "warn",
              detail: `No queues found under prefix '${prefix}'`,
              hint: "If your queues use a custom BullMQ prefix, pass --prefix <prefix>.",
            });
          } else {
            const sample = names.slice(0, DISCOVERY_SAMPLE_SIZE).join(", ");
            const more = names.length > DISCOVERY_SAMPLE_SIZE ? ", …" : "";
            checks.push({
              name: "queue-discovery",
              status: "ok",
              detail: `${names.length} queue(s) under prefix '${prefix}': ${sample}${more}`,
            });
          }
        } catch (error) {
          checks.push({
            name: "queue-discovery",
            status: "fail",
            detail: "Queue discovery failed",
            hint: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await probe.close().catch(() => {});
    }
  }

  return {
    timestamp: new Date().toISOString(),
    command: "doctor",
    version: getVersionText(),
    runtime: `bun ${process.versions.bun ?? "unknown"} on ${process.platform} ${process.arch}`,
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

// ── CLI entry point ─────────────────────────────────────────────────────

/**
 * Run diagnostics and exit. Unlike the other subcommands, doctor never
 * hard-exits on config problems — a broken config file is a finding, not a
 * reason to stop diagnosing. Exit code: 0 when no check failed, 1 otherwise.
 */
export async function runDoctorMode(cliArgs: CliArgs): Promise<void> {
  const report = await runDoctor({
    ...(cliArgs.redisUrl !== undefined && { redisUrl: cliArgs.redisUrl }),
    ...(cliArgs.profile !== undefined && { profileName: cliArgs.profile }),
    ...(cliArgs.configPath !== undefined && { configPath: cliArgs.configPath }),
    ...(cliArgs.prefix !== undefined && { prefix: cliArgs.prefix }),
  });

  const output = cliArgs.humanFriendly ? formatDoctorReport(report) : JSON.stringify(report);
  process.stdout.write(output + "\n");
  process.exit(report.ok ? 0 : 1);
}
