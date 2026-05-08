import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { Config, CliArgs } from "./config.js";
import { formatRedisUrl } from "./profiles.js";

function buildTuiArgs(config: Config): string[] {
  const scriptPath = process.argv[1];

  if (!scriptPath) {
    throw new Error("Unable to resolve current script path for PTY child process.");
  }

  // Reconstruct a URL so the child process sees the same single-source shape
  // as everywhere else. Round-tripping through formatRedisUrl + parseRedisUrl
  // preserves credentials and TLS choice.
  const url = formatRedisUrl({
    host: config.redis.host,
    port: config.redis.port,
    username: config.redis.username,
    password: config.redis.password,
    db: config.redis.db,
    tls: config.redis.tls,
  });

  const args = [
    scriptPath,
    "--tui",
    "--redis-url",
    url,
    "--poll-interval",
    String(config.pollInterval),
    "--prefix",
    config.prefix,
  ];

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
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap');
      @import url('https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css');
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #11111b;
        overflow: hidden;
      }
      body {
        display: flex;
        flex-direction: column;
      }
      #status {
        flex: 0 0 auto;
        font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #cdd6f4;
        background: #1e1e2e;
        border-bottom: 1px solid #313244;
        padding: 8px 12px;
        display: none;
      }
      #status[data-state="connecting"] { display: block; color: #f9e2af; }
      #status[data-state="reconnecting"] { display: block; color: #fab387; }
      #status[data-state="error"] { display: block; color: #f38ba8; }
      #terminal {
        flex: 1 1 auto;
        min-height: 0;
        width: 100%;
        padding: 8px;
        box-sizing: border-box;
        background: #11111b;
      }
      #terminal .xterm {
        height: 100%;
        padding: 8px;
      }
      #terminal .xterm-viewport {
        overflow-y: auto !important;
      }
    </style>
  </head>
  <body>
    <div id="status" role="status" aria-live="polite"></div>
    <div id="terminal" tabindex="0"></div>
<script type="module">
      import { Terminal } from "https://cdn.jsdelivr.net/npm/xterm@5.3.0/+esm";
      import { FitAddon } from "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/+esm";

      const terminalNode = document.getElementById("terminal");
      const statusNode = document.getElementById("status");
      const wsBase = new URL("/pty", window.location.href);
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

      const term = new Terminal({
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 14,
        fontWeight: 400,
        theme: {
          background: '#11111b',
          foreground: '#cdd6f4',
          cursor: '#cdd6f4',
          selectionBackground: '#45475a',
          black: '#45475a',
          red: '#f38ba8',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          blue: '#89b4fa',
          magenta: '#cba6f7',
          cyan: '#94e2d4',
          white: '#bac2de',
          brightBlack: '#585b70',
          brightRed: '#f38ba8',
          brightGreen: '#a6e3a1',
          brightYellow: '#f9e2af',
          brightBlue: '#89b4fa',
          brightMagenta: '#cba6f7',
          brightCyan: '#94e2d2',
          brightWhite: '#a6adc8',
        },
        cursorBlink: true,
        cursorStyle: 'block',
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

// Key handler: send directly to socket via exposed reference  
      function handleKey(e) {
        var ws = window.ws;
        if (!ws || ws.readyState !== 1) return;
        
        var key = e.key;
        var seq = '';
        
        if (key === 'ArrowUp') seq = String.fromCharCode(27) + '[A';
        else if (key === 'ArrowDown') seq = String.fromCharCode(27) + '[B';
        else if (key === 'ArrowRight') seq = String.fromCharCode(27) + '[C';
        else if (key === 'ArrowLeft') seq = String.fromCharCode(27) + '[D';
        else if (key === 'Enter') seq = String.fromCharCode(13);
        else if (key === 'Escape') seq = String.fromCharCode(27);
        else if (key === 'Backspace') seq = String.fromCharCode(127);
        else if (key === 'Tab') seq = String.fromCharCode(9);
        else if (key === 'j') seq = 'j';
        else if (key === 'k') seq = 'k';
        else if (key === 'q') seq = 'q';
        else if (key === 'r') seq = 'r';
        else if (key === 'd') seq = 'd';
        else if (key === 'g') seq = 'g';
        else if (key === 'y') seq = 'y';
        else if (key === 'n') seq = 'n';
        else if (key === 'c' && e.ctrlKey) seq = String.fromCharCode(3);
        else if (key.length === 1) seq = key;
        
        if (seq) ws.send(seq);
      }
      
      // Add to document with capture to ensure early handling
      document.addEventListener('keydown', handleKey, true);

      term.open(terminalNode);
      fitAddon.fit();
      term.focus();
      window.term = term;

      let socket = null;
      let attempt = 0;
      let manualClose = false;

      function sendResize() {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const cols = term.cols;
        const rows = term.rows;
        socket.send(\`\\x1b[RESIZE:\${cols};\${rows}]\`);
      }

function connect() {
        attempt += 1;
        setStatus(attempt === 1 ? "connecting" : "reconnecting",
          attempt === 1 ? "Connecting to bullmq-dash..." : ("Reconnecting (attempt " + attempt + ")..."));

        socket = new WebSocket(wsBase);
        
        // Expose socket globally for key handler
        window.ws = socket;

        socket.addEventListener("open", () => {
          attempt = 0;
          setStatus(null);
          sendResize();
          term.focus();
        });

        let resizeTimeout;
        window.addEventListener("resize", () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            fitAddon.fit();
            sendResize();
          }, 100);
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
    console.log("WebSocket connected:", socket?.readyState);
    
    const proc = Bun.spawn([process.execPath, ...buildTuiArgs(config)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
      terminal: {
        cols: 120,
        rows: 36,
        data(_terminal, chunk) {
          if (socket.readyState === socket.OPEN) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            socket.send(text);
          }
        },
      },
    });

    const terminal = proc.terminal!;
    if (!terminal) {
      socket.close();
      return;
    }

    let alive = true;

    function killTerm(): void {
      if (!alive) return;
      alive = false;
      try {
        terminal.close();
      } catch {
        // terminal already gone
      }
      try {
        proc.kill();
      } catch {
        // process already dead
      }
    }

    proc.exited.then(() => {
      alive = false;
      if (socket.readyState === socket.OPEN) {
        socket.close();
      }
    });

    socket.on("message", (raw: ArrayBuffer | Buffer | string) => {
      if (!alive) return;
      const data = String(raw);
      console.log('[WS->PTY] incoming:', JSON.stringify(data), 'len:', data.length);

      const resizeMatch = data.match(
        new RegExp(`^${String.fromCharCode(27)}\\[RESIZE:(\\d+);(\\d+)\\]$`),
      );

      if (resizeMatch) {
        const cols = Number(resizeMatch[1]);
        const rows = Number(resizeMatch[2]);
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          try {
            terminal.resize(cols, rows);
          } catch (err) {
            app.log.warn({ err }, "pty resize failed, killing terminal");
            killTerm();
            if (socket.readyState === socket.OPEN) socket.close();
          }
        }
        return;
      }

      try {
        console.log('[WS->PTY] writing to pty:', data);
        terminal.write(data);
      } catch (err) {
        app.log.warn({ err }, "pty write failed, killing terminal");
        killTerm();
        if (socket.readyState === socket.OPEN) socket.close();
      }
    });

    socket.on("close", () => {
      killTerm();
    });

    socket.on("error", () => {
      killTerm();
    });
  });

  await app.listen({ port, host });

  console.log(`Web terminal available at http://${host}:${port}`);
}
