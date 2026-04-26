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

export function createWebClientHtml(websocketPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>bullmq-dash web</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #11111b;
      }
      body {
        display: flex;
        flex-direction: column;
      }
      #status {
        flex: 0 0 auto;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #cdd6f4;
        background: #1e1e2e;
        border-bottom: 1px solid #313244;
        padding: 6px 10px;
        display: none;
      }
      #status[data-state="connecting"] { display: block; color: #f9e2af; }
      #status[data-state="reconnecting"] { display: block; color: #fab387; }
      #status[data-state="error"] { display: block; color: #f38ba8; }
      #terminal {
        flex: 1 1 auto;
        min-height: 0;
        width: 100%;
      }
    </style>
  </head>
  <body>
    <div id="status" role="status" aria-live="polite"></div>
    <div id="terminal"></div>
    <script type="module">
      import { WTerm } from "https://cdn.jsdelivr.net/npm/@wterm/dom@0.1.9/+esm";

      const terminalNode = document.getElementById("terminal");
      const statusNode = document.getElementById("status");
      const wsBase = new URL("${websocketPath}", window.location.href);
      wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";

      function setStatus(state, message) {
        if (!message) {
          statusNode.removeAttribute("data-state");
          statusNode.textContent = "";
          return;
        }
        statusNode.dataset.state = state;
        statusNode.textContent = message;
      }

      const term = new WTerm(terminalNode, {
        onData(data) {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        onResize(cols, rows) {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(\`\\x1b[RESIZE:\${cols};\${rows}]\`);
          }
        },
      });

      await term.init();

      let socket = null;
      let attempt = 0;
      let manualClose = false;

      function connect() {
        attempt += 1;
        setStatus(attempt === 1 ? "connecting" : "reconnecting",
          attempt === 1 ? "Connecting to bullmq-dash…" : \`Reconnecting (attempt \${attempt})…\`);

        socket = new WebSocket(wsBase);

        socket.addEventListener("open", () => {
          attempt = 0;
          setStatus(null);
          socket.send(\`\\x1b[RESIZE:\${term.cols};\${term.rows}]\`);
          term.focus();
        });

        socket.addEventListener("message", (event) => {
          term.write(String(event.data));
        });

        socket.addEventListener("close", () => {
          if (manualClose) return;
          const delay = Math.min(15000, 500 * Math.pow(2, Math.min(attempt - 1, 5)));
          setStatus("reconnecting", \`Lost connection — retrying in \${Math.round(delay / 1000)}s…\`);
          setTimeout(connect, delay);
        });

        socket.addEventListener("error", () => {
          setStatus("error", "WebSocket error — check the bullmq-dash server logs.");
        });
      }

      window.addEventListener("beforeunload", () => {
        manualClose = true;
        if (socket) socket.close();
      });

      connect();
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

  app.get(websocketPath, { websocket: true }, (socket: any) => {
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
      if (socket.readyState === socket.OPEN) {
        socket.send(chunk);
      }
    });

    term.onExit(() => {
      if (socket.readyState === socket.OPEN) {
        socket.close();
      }
    });

    socket.on("message", (raw: ArrayBuffer | Buffer | string) => {
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

    socket.on("close", () => {
      term.kill();
    });

    socket.on("error", () => {
      term.kill();
    });
  });

  await app.listen({ port, host });

  console.log(`Web terminal available at http://${host}:${port}`);
}
