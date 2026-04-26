import { describe, expect, it } from "bun:test";
import { createWebClientHtml } from "./web-server.js";

// Regression: ISSUE-002 — RESIZE socket.send used double-quoted strings, so
// `${cols};${rows}` was sent literally instead of the actual viewport size.
// Found by /qa on 2026-04-26
// Report: .gstack/qa-reports/qa-report-127-0-0-1-3001-2026-04-26.md
describe("createWebClientHtml — RESIZE message interpolation", () => {
  it("uses backticks (template literals) so cols/rows interpolate", () => {
    const html = createWebClientHtml("/pty");

    const onResizeMatch = html.match(/onResize\(cols, rows\)\s*\{[^}]*socket\.send\(([^)]+)\);/);
    expect(onResizeMatch).not.toBeNull();
    const onResizeArg = onResizeMatch![1]!;
    expect(onResizeArg.startsWith("`")).toBe(true);
    expect(onResizeArg.includes("${cols}")).toBe(true);
    expect(onResizeArg.includes("${rows}")).toBe(true);

    const openHandlerArg = html.match(
      /open[\s\S]*?socket\.send\((`[^`]*\$\{term\.cols\}[^`]*`)\)/,
    );
    expect(openHandlerArg).not.toBeNull();
  });

  it("never sends a literal ${cols} or ${rows} string", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes('"\\x1b[RESIZE:${cols};${rows}]"')).toBe(false);
    expect(html.includes('"\\x1b[RESIZE:${term.cols};${term.rows}]"')).toBe(false);
  });
});

// Regression: ISSUE-004 — disconnects only printed [disconnected] in dim red
// inside the terminal pane, with no reconnect logic and no actionable text.
// Found by /qa on 2026-04-26
// Report: .gstack/qa-reports/qa-report-127-0-0-1-3001-2026-04-26.md
describe("createWebClientHtml — connection status UI", () => {
  it("renders a status banner element with aria-live", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes('id="status"')).toBe(true);
    expect(html.includes('aria-live="polite"')).toBe(true);
  });

  it("schedules a reconnect via setTimeout when the socket closes", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("setTimeout(connect")).toBe(true);
    expect(html.includes("Lost connection")).toBe(true);
  });

  it("declares connecting / reconnecting / error visual states in CSS", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes('#status[data-state="connecting"]')).toBe(true);
    expect(html.includes('#status[data-state="reconnecting"]')).toBe(true);
    expect(html.includes('#status[data-state="error"]')).toBe(true);
  });
});

describe("createWebClientHtml — WebSocket URL", () => {
  it("embeds the websocket path passed by the server", () => {
    const html = createWebClientHtml("/custom-pty");

    expect(html.includes('new URL("/custom-pty", window.location.href)')).toBe(true);
  });
});
