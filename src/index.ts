import { App } from "./app.js";
import {
  parseCliArgs,
  showHelp,
  showVersion,
  hasRedisHostConfig,
  shouldLoadProfile,
} from "./cli.js";
import { loadConfig, createConfigFromPrompt } from "./config.js";
import { loadProfile } from "./profiles.js";
import { runConfigPrompt } from "./ui/config-prompt.js";
import { runDoctorMode } from "./doctor.js";
import { runJsonMode } from "./json-reporter.js";
import { runWebMode, WebRedisConnectionError } from "./web/server.js";
import { writeError } from "./errors.js";
import { createContext } from "./context.js";

async function main() {
  // Parse CLI arguments
  const cliArgs = parseCliArgs();

  // Handle --help and --version
  if (cliArgs.help) {
    showHelp();
    return;
  }

  if (cliArgs.version) {
    showVersion();
    return;
  }

  // Doctor routes before profile loading: it inspects the config file itself
  // and reports problems as checks instead of exiting like loadProfile does.
  if (cliArgs.subcommand?.kind === "doctor") {
    await runDoctorMode(cliArgs);
    return;
  }

  // Resolve profile only when the connection may come from config, or when the
  // user explicitly asked for config/profile behavior. A direct --redis-url is
  // enough on its own and should not be blocked by stale ambient config env.
  const profile = shouldLoadProfile(cliArgs)
    ? loadProfile({
        configPath: cliArgs.configPath,
        profileName: cliArgs.profile,
      })
    : null;

  // Subcommand mode (headless JSON output)
  if (cliArgs.subcommand) {
    if (!hasRedisHostConfig(cliArgs, profile)) {
      writeError(
        "Redis URL is not configured",
        "CONFIG_ERROR",
        "Use --redis-url <url> or --profile <name> to specify the Redis server.",
      );
      process.exit(2);
    }

    const config = loadConfig(cliArgs, profile);
    const ctx = createContext(config);
    await runJsonMode(ctx, cliArgs.subcommand, cliArgs.humanFriendly, cliArgs.yes);
    return;
  }

  if (cliArgs.web) {
    if (!hasRedisHostConfig(cliArgs, profile)) {
      writeError(
        "Redis URL is not configured",
        "CONFIG_ERROR",
        "Use --redis-url <url> or --profile <name> to specify the Redis server.",
      );
      process.exit(2);
    }

    const config = loadConfig(cliArgs, profile);
    const ctx = createContext(config);
    try {
      await runWebMode(ctx, {
        host: cliArgs.webHost ?? "127.0.0.1",
        port: cliArgs.webPort ?? 3000,
        readOnly: cliArgs.webReadOnly ?? false,
      });
    } catch (error) {
      if (error instanceof WebRedisConnectionError) {
        writeError("Redis connection failed", "REDIS_ERROR", error.message);
        process.exit(1);
      }
      writeError(
        "Failed to start web UI",
        "RUNTIME_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
    return;
  }

  // TUI mode (requires --tui flag)
  if (cliArgs.tui) {
    let config;

    if (hasRedisHostConfig(cliArgs, profile)) {
      config = loadConfig(cliArgs, profile);
      console.log(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`);
      console.log("");
    } else {
      const url = await runConfigPrompt();
      config = createConfigFromPrompt(url, cliArgs);
    }

    try {
      const ctx = createContext(config);
      const app = new App(ctx);
      await app.start();
    } catch (error) {
      writeError(
        "Failed to start application",
        "RUNTIME_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
    return;
  }

  // No subcommand and no --tui: show help with exit code 2 (no command given)
  showHelp(2);
}

main();
