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
import { runJsonSnapshot } from "./json-reporter.js";
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

  // JSON / headless mode
  if (cliArgs.json) {
    if (!hasRedisHostConfig(cliArgs)) {
      writeError("Redis host is not configured", "CONFIG_ERROR");
      process.exit(2);
    }

    const config = loadConfig(cliArgs);
    await runJsonSnapshot(config);
    return;
  }

  let config;

  // Check if Redis host is configured
  if (hasRedisHostConfig(cliArgs)) {
    // Load config from CLI args and env vars
    config = loadConfig(cliArgs);
    console.log(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`);
    console.log("");
  } else {
    // Run interactive prompt
    const promptAnswers = await runConfigPrompt();
    config = createConfigFromPrompt(promptAnswers, cliArgs);
  }

  // Set the global config
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
}

main();
