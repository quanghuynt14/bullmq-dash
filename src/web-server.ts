import Fastify from "fastify";
import websocket from "@fastify/websocket";
import pty from "node-pty";
import type { Config, CliArgs } from "./config.js";

function buildTuiArgs(config: Config): string[] {
  const scriptPath = process.argv[1];

  if (!scriptPath) {
    throw new Error("Unable to resolve current script path for PTY child process.");
  }

  const args = [
    scriptPath,
    "--tui",
    "--redis-host",
    config.redis.host,
    "--redis-port",
    String(config.redis.port),
    "--redis-db",
    String(config.redis.db),
    "--poll-interval",
    String(config.pollInterval),
    "--prefix",
    config.prefix,
  ];

  if (config.redis.password) {
    args.push("--redis-password", config.redis.password);
  }

  if (config.queueNames && config.queueNames.length > 0) {
    args.push("--queues", config.queueNames.join(","));
  }

  return args;
}

function createWebClientHtml(websocketPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>bullmq-dash web</title>
    <style>
      html, body, #terminal {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #11111b;
      }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { WTerm } from "https://cdn.jsdelivr.net/npm/@wterm/dom@0.1.9/dist/index.js";

      const terminalNode = document.getElementById("terminal");
      const wsUrl = new URL("${websocketPath}", window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

      const socket = new WebSocket(wsUrl);
      const term = new WTerm(terminalNode, {
        onData(data) {
          socket.send(data);
        },
        onResize(cols, rows) {
          socket.send("\\x1b[RESIZE:\${cols};\${rows}]");
        },
      });

      await term.init();

      socket.addEventListener("open", () => {
        socket.send("\\x1b[RESIZE:\${term.cols};\${term.rows}]");
        term.focus();
      });

      socket.addEventListener("message", (event) => {
        term.write(String(event.data));
      });

      socket.addEventListener("close", () => {
        term.write("\\r\\n\\x1b[31m[disconnected]\\x1b[0m\\r\\n");
      });
    </script>
  </body>
</html>`;
}

export async function startWebServer(config: Config, cliArgs: CliArgs): Promise<void> {
  const port = cliArgs.webPort ?? 3001;
  const host = cliArgs.webHost ?? "127.0.0.1";
  const websocketPath = "/pty";

  const app = Fastify({ logger: true });

  await app.register(websocket);

  app.get("/", async (_request: any, reply: any) => {
    reply.type("text/html").send(createWebClientHtml(websocketPath));
  });

  app.get("/health", async () => ({ ok: true }));

  app.get(websocketPath, { websocket: true }, (connection: any) => {
    const term = pty.spawn(process.execPath, buildTuiArgs(config), {
      name: "xterm-256color",
      cols: 120,
      rows: 36,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });

    term.onData((chunk: string) => {
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(chunk);
      }
    });

    term.onExit(() => {
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.close();
      }
    });

    connection.socket.on("message", (raw: ArrayBuffer | Buffer | string) => {
      const data = String(raw);
      const resizeMatch = data.match(/^\x1b\[RESIZE:(\d+);(\d+)\]$/);

      if (resizeMatch) {
        const cols = Number(resizeMatch[1]);
        const rows = Number(resizeMatch[2]);
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          term.resize(cols, rows);
        }
        return;
      }

      term.write(data);
    });

    connection.socket.on("close", () => {
      term.kill();
    });

    connection.socket.on("error", () => {
      term.kill();
    });
  });

  await app.listen({ port, host });

  console.log(`Web terminal available at http://${host}:${port}`);
}
