import { App } from "./app.js";
import {
  parseCliArgs,
  showHelp,
  showVersion,
  hasRedisHostConfig,
  shouldLoadProfile,
} from "./cli.js";
import { loadConfig, createConfigFromPrompt, setConfig } from "./config.js";
import { loadProfile } from "./profiles.js";
import { runConfigPrompt } from "./ui/config-prompt.js";
import { runJsonMode } from "./json-reporter.js";
import { writeError } from "./errors.js";

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
    await runJsonMode(
      config,
      cliArgs.subcommand,
      cliArgs.humanFriendly,
      cliArgs.dryRun,
      cliArgs.yes,
    );
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

    setConfig(config);

    try {
      const app = new App();
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
