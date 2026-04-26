import { describe, expect, it } from "bun:test";
import { createWebClientHtml } from "./web-server.js";

// Note: Using xterm.js instead of @wterm/dom
describe("createWebClientHtml — terminal setup", () => {
  it("loads xterm.js from CDN", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("xterm@5.3.0")).toBe(true);
    expect(html.includes("xterm-addon-fit")).toBe(true);
  });

  it("loads xterm CSS from CDN", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("xterm.min.css")).toBe(true);
  });

  it("configures JetBrains Mono font", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("JetBrains Mono")).toBe(true);
  });

  it("configures Catppuccin theme colors", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("#f38ba8")).toBe(true); // red
    expect(html.includes("#a6e3a1")).toBe(true); // green
    expect(html.includes("#11111b")).toBe(true); // background
  });

  it("has connect function for WebSocket", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("function connect()")).toBe(true);
    expect(html.includes("WebSocket")).toBe(true);
  });

  it("handles window resize with fitAddon", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes("fitAddon.fit()")).toBe(true);
    expect(html.includes("window.addEventListener(\"resize\"")).toBe(true);
  });
});

describe("createWebClientHtml — WebSocket URL", () => {
  it("uses /pty as default websocket path", () => {
    const html = createWebClientHtml("/pty");

    expect(html.includes('/pty"')).toBe(true);
  });
});