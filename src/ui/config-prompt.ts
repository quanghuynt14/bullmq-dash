import * as readline from "readline";
import { parseRedisUrl } from "../profiles.js";

// ANSI color codes for terminal output
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

const DEFAULT_URL = "redis://localhost:6379";

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Prompt the user for a single Redis connection URL. Loops on invalid input
 * (bad scheme, malformed URL) so a typo doesn't kick them back to the shell.
 *
 * Passwords inside URLs are entered visibly — the trade-off for using URL
 * format. Anyone who needs masked input can pass `--redis-url` from the shell
 * (with history-disabling shell tricks) or use a profile with `${ENV_VAR}`.
 */
export async function runConfigPrompt(): Promise<string> {
  const rl = createReadlineInterface();

  console.log();
  console.log(bold(cyan("Redis Connection Setup")));
  console.log(dim("Format: redis://[user:pass@]host[:port][/db]  (rediss:// for TLS)"));
  console.log();

  try {
    while (true) {
      // Sequential by design — re-prompt until the user enters something parseable.
      // eslint-disable-next-line no-await-in-loop
      const input = await prompt(rl, `Redis URL ${dim(`[${DEFAULT_URL}]`)}: `);
      const url = input.trim() || DEFAULT_URL;

      try {
        const parts = parseRedisUrl(url);
        console.log();
        console.log(green("✓") + ` Connecting to ${parts.host}:${parts.port}...`);
        console.log();
        return url;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(red("✗") + ` ${msg}`);
        console.log();
      }
    }
  } finally {
    rl.close();
  }
}
