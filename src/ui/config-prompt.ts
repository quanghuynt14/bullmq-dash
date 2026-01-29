import * as readline from "readline";

export interface ConfigPromptAnswers {
  host: string;
  port: number;
  password?: string;
}

// ANSI color codes for terminal output
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

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

function promptPassword(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    // For password, we'll use a simple approach
    // Note: This won't mask input in all terminals, but works for basic cases
    process.stdout.write(question);

    let password = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    const onData = (char: Buffer) => {
      const c = char.toString("utf8");

      switch (c) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl+D
          stdin.removeListener("data", onData);
          if (stdin.isTTY) {
            stdin.setRawMode(wasRaw ?? false);
          }
          console.log(); // New line after password
          resolve(password);
          break;
        case "\u0003": // Ctrl+C
          process.exit(0);
          break;
        case "\u007F": // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write("\b \b"); // Erase character
          }
          break;
        default:
          password += c;
          process.stdout.write("*");
          break;
      }
    };

    stdin.on("data", onData);
  });
}

export async function runConfigPrompt(): Promise<ConfigPromptAnswers> {
  const rl = createReadlineInterface();

  console.log();
  console.log(bold(cyan("Redis Connection Setup")));
  console.log();

  try {
    // Host
    const hostInput = await prompt(rl, `Redis Host ${dim("[localhost]")}: `);
    const host = hostInput.trim() || "localhost";

    // Port
    const portInput = await prompt(rl, `Redis Port ${dim("[6379]")}: `);
    const port = portInput.trim() ? parseInt(portInput.trim(), 10) : 6379;

    if (isNaN(port) || port <= 0 || port > 65535) {
      console.error("Invalid port number. Using default 6379.");
    }

    // Close readline before password prompt (we use raw mode for password)
    rl.close();

    // Password (with masking)
    const password = await promptPassword(
      createReadlineInterface(),
      `Redis Password ${dim("(empty for none)")}: `,
    );

    console.log();
    console.log(green("✓") + ` Connecting to ${host}:${port}...`);
    console.log();

    return {
      host,
      port: isNaN(port) || port <= 0 ? 6379 : port,
      password: password || undefined,
    };
  } finally {
    rl.close();
  }
}
