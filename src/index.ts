import { App } from "./app.js";
import { getConfig } from "./config.js";

async function main() {
  // Load and validate config (will exit if invalid)
  const config = getConfig();

  // Print startup info
  console.log("BullMQ TUI Dashboard");
  console.log(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`);
  console.log("");

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
