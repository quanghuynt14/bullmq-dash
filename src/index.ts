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

  let config;

  // Check if Redis host is configured
  if (hasRedisHostConfig(cliArgs)) {
    // Load config from CLI args and env vars
    config = loadConfig(cliArgs);
    console.log("BullMQ Dash");
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
    console.error("Failed to start application:");
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

main();
