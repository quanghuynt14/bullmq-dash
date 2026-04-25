import { App } from "./app.js";
import {
  parseCliArgs,
  showHelp,
  showVersion,
  hasRedisHostConfig,
  loadConfig,
  createConfigFromPrompt,
  setConfig,
} from "./config.js";
import { runConfigPrompt } from "./ui/config-prompt.js";
import { runJsonMode } from "./json-reporter.js";
import { writeError } from "./errors.js";
import { startWebServer } from "./web-server.js";

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

  // Subcommand mode (headless JSON output)
  if (cliArgs.subcommand) {
    if (!hasRedisHostConfig(cliArgs)) {
      writeError(
        "Redis host is not configured",
        "CONFIG_ERROR",
        "Use --redis-host <host> to specify the Redis server.",
      );
      process.exit(2);
    }

    const config = loadConfig(cliArgs);
    await runJsonMode(config, cliArgs.subcommand, cliArgs.humanFriendly);
    return;
  }

  // TUI mode (requires --tui flag)
  if (cliArgs.tui) {
    let config;

    if (hasRedisHostConfig(cliArgs)) {
      config = loadConfig(cliArgs);
      console.log(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`);
      console.log("");
    } else {
      const promptAnswers = await runConfigPrompt();
      config = createConfigFromPrompt(promptAnswers, cliArgs);
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

  // Web mode (requires --web flag)
  if (cliArgs.web) {
    if (!hasRedisHostConfig(cliArgs)) {
      writeError(
        "Redis host is not configured",
        "CONFIG_ERROR",
        "Use --redis-host <host> with --web mode.",
      );
      process.exit(2);
    }

    const config = loadConfig(cliArgs);

    try {
      await startWebServer(config, cliArgs);
    } catch (error) {
      writeError(
        "Failed to start web server",
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
