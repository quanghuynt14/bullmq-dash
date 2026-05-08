import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writeError } from "./errors.js";

// ── Schema ──────────────────────────────────────────────────────────────
//
// Profiles only carry a Redis URL — discrete host/port/etc. fields were removed
// in the URL-only redesign so there's exactly one way to describe a connection.
const profileSchema = z
  .object({
    redis: z
      .object({
        url: z.string(),
      })
      .strict()
      .optional(),
    pollInterval: z.coerce.number().int().positive().optional(),
    prefix: z.string().optional(),
    queues: z.array(z.string()).optional(),
  })
  .strict();

const profilesFileSchema = z
  .object({
    defaultProfile: z.string().optional(),
    profiles: z.record(z.string(), profileSchema).default({}),
  })
  .strict();

export type Profile = z.infer<typeof profileSchema>;
export type ProfilesFile = z.infer<typeof profilesFileSchema>;

// ── Path resolution ─────────────────────────────────────────────────────

/**
 * Resolve the config file path with this precedence:
 *   1. explicit --config flag (caller supplies it)
 *   2. $BULLMQ_DASH_CONFIG env var
 *   3. $XDG_CONFIG_HOME/bullmq-dash/config.json
 *   4. ~/.config/bullmq-dash/config.json
 *
 * Returned path is not checked for existence — callers handle missing files.
 */
export function resolveConfigPath(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicitPath) return explicitPath;
  if (env.BULLMQ_DASH_CONFIG) return env.BULLMQ_DASH_CONFIG;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "bullmq-dash", "config.json");
  return join(homedir(), ".config", "bullmq-dash", "config.json");
}

// ── Env-var interpolation ───────────────────────────────────────────────

const ENV_REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/i;

/**
 * Walk a parsed profile and replace any string of the exact form `${VAR}`
 * with the corresponding env var. Unknown vars are a hard error so secrets
 * never silently resolve to "undefined" or empty strings.
 *
 * Only whole-string substitution is supported (no partial/templated strings)
 * — keeps the syntax obvious and avoids quoting hazards.
 */
export function expandEnvRefs<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    const match = value.match(ENV_REF);
    if (!match) return value;
    const key = match[1]!;
    const resolved = env[key];
    if (resolved === undefined) {
      throw new Error(`Environment variable '${key}' referenced in profile is not set`);
    }
    return resolved as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvRefs(v, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvRefs(v, env);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Loading + resolution ────────────────────────────────────────────────

export interface LoadProfileOptions {
  /** Explicit --config path. */
  configPath?: string;
  /** Explicit --profile name. */
  profileName?: string;
  /** Override env (testing). */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedProfile {
  /** Source path the profile came from, for diagnostics. */
  sourcePath: string;
  /** Profile name actually applied. */
  name: string;
  /** Profile contents after env-var expansion. */
  profile: Profile;
}

/**
 * Load and resolve a profile. Returns null when no profile applies (no config
 * file present and no --config / --profile requested) so the caller can fall
 * through to CLI-flags-only behavior (the pre-profiles default).
 *
 * Hard errors (process.exit(2)):
 *   - --config or --profile given but file is missing/unreadable
 *   - --profile given but the named profile doesn't exist
 *   - file contents fail schema validation
 *   - an env-var reference inside the profile can't be resolved
 */
export function loadProfile(opts: LoadProfileOptions = {}): ResolvedProfile | null {
  const env = opts.env ?? process.env;
  const explicitConfig = !!opts.configPath || !!env.BULLMQ_DASH_CONFIG;
  const explicitProfile = !!opts.profileName;
  const path = resolveConfigPath(opts.configPath, env);

  if (!existsSync(path)) {
    if (explicitConfig || explicitProfile) {
      writeError(
        `Config file not found: ${path}`,
        "CONFIG_ERROR",
        explicitConfig
          ? "Check the path passed to --config or $BULLMQ_DASH_CONFIG."
          : `--profile requires a config file. Create one at ${path} or pass --config <path>.`,
      );
      process.exit(2);
    }
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    writeError(
      `Failed to parse config file: ${path}`,
      "CONFIG_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(2);
  }

  const parsed = profilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    writeError(
      `Invalid config file: ${path}`,
      "CONFIG_ERROR",
      JSON.stringify(parsed.error.flatten()),
    );
    process.exit(2);
  }

  const file = parsed.data;
  const name = opts.profileName ?? file.defaultProfile;

  if (!name) return null;

  const profile = file.profiles[name];
  if (!profile) {
    const available = Object.keys(file.profiles);
    writeError(
      `Profile '${name}' not found in ${path}`,
      "CONFIG_ERROR",
      available.length > 0
        ? `Available profiles: ${available.join(", ")}`
        : "No profiles are defined in the config file.",
    );
    process.exit(2);
  }

  let expanded: Profile;
  try {
    expanded = expandEnvRefs(profile, env);
  } catch (error) {
    writeError(
      `Failed to resolve env vars in profile '${name}'`,
      "CONFIG_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(2);
  }

  return { sourcePath: path, name, profile: expanded };
}

// ── Redis URL parsing ───────────────────────────────────────────────────

export interface ParsedRedisUrl {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: boolean;
}

function decodeUrlAuthField(raw: string, field: "username" | "password"): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error(`Invalid percent-encoding in URL ${field}`);
  }
}

/**
 * Strip userinfo (user:pass@) from a URL-shaped string for safe inclusion in
 * error messages. Operates on the raw string so it works even on URLs that
 * `new URL` rejected. Anything between `://` and the next `@` is masked —
 * worst case a malformed URL gets over-redacted, which is the safe direction.
 */
function redactUrl(input: string): string {
  return input.replace(/(:\/\/)[^/]*@/, "$1[REDACTED]@");
}

/**
 * Parse a `redis://` or `rediss://` URL into discrete fields. Throws with a
 * helpful message on bad input so callers can wrap it in a CONFIG_ERROR.
 * Userinfo is redacted from any echoed input so passwords don't leak into
 * stderr (and onward into CI logs / bug reports / screenshares).
 *
 * Supported shape: `[redis|rediss]://[user[:pass]@]host[:port][/db]`. Query
 * strings and fragments are rejected (not silently dropped) — the most
 * common footgun is `?ssl=true` failing to enable TLS and downgrading the
 * connection to plaintext.
 */
export function parseRedisUrl(input: string): ParsedRedisUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Not a valid URL: ${redactUrl(input)}`);
  }

  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(`Unsupported scheme '${parsed.protocol}' (expected redis:// or rediss://)`);
  }

  if (!parsed.hostname) {
    throw new Error(`Missing host in URL: ${redactUrl(input)}`);
  }

  if (parsed.search || parsed.hash) {
    // Reject rather than silently drop. Common footgun: `?ssl=true` is not a
    // supported TLS toggle (use `rediss://`) and silently dropping it would
    // downgrade the connection to plaintext.
    throw new Error(
      "Query parameters and fragments are not supported in Redis URLs. " +
        "For TLS, use rediss:// (not ?ssl=true).",
    );
  }

  // URL.password / URL.username are percent-encoded; decode so the value sent
  // to Redis matches what the user wrote in the URL. Wrap the decoder so a
  // malformed escape (e.g. `%bad`) surfaces as a clear message instead of the
  // built-in opaque `URIError: URI malformed`.
  const username = parsed.username ? decodeUrlAuthField(parsed.username, "username") : undefined;
  const password = parsed.password ? decodeUrlAuthField(parsed.password, "password") : undefined;

  // Path is "/<db>" or "" — anything else (e.g. "/0/extra") is ambiguous.
  let db: number | undefined;
  if (parsed.pathname && parsed.pathname !== "/") {
    const trimmed = parsed.pathname.replace(/^\//, "");
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Database in URL must be a non-negative integer, got '/${trimmed}'`);
    }
    db = Number(trimmed);
  }

  const port = parsed.port ? Number(parsed.port) : 6379;

  return {
    host: parsed.hostname,
    port,
    username,
    password,
    db,
    tls: parsed.protocol === "rediss:",
  };
}
