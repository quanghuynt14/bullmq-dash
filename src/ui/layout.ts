import { type CliRenderer, BoxRenderable, TextRenderable, t, fg, bold } from "@opentui/core";
import { colors } from "./colors.js";

export interface LayoutElements {
  // Root containers
  root: BoxRenderable;
  header: BoxRenderable;
  headerTitle: TextRenderable;
  headerStatus: TextRenderable;

  // Metrics bar
  metricsBar: BoxRenderable;

  // Main content area
  mainContent: BoxRenderable;

  // Left pane (queues)
  leftPane: BoxRenderable;

  // Right pane (jobs)
  rightPane: BoxRenderable;

  // Footer
  footer: BoxRenderable;
  footerText: TextRenderable;
}

export function createLayout(renderer: CliRenderer): LayoutElements {

  // Root container - fills entire terminal
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  renderer.root.add(root);

  // Header
  const header = new BoxRenderable(renderer, {
    id: "header",
    flexDirection: "row",
    width: "100%",
    height: 3,
    backgroundColor: colors.surface0,
    borderStyle: "single",
    borderColor: colors.lavender,
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
    border: true,
  });
  root.add(header);

  const headerTitle = new TextRenderable(renderer, {
    id: "header-title",
    content: t`${bold(fg(colors.text)("BullMQ"))}`,
    fg: colors.text,
  });
  header.add(headerTitle);

  const headerStatus = new TextRenderable(renderer, {
    id: "header-status",
    content: "Connecting...",
    fg: colors.yellow,
  });
  header.add(headerStatus);

  // Metrics bar - sits between header and main content
  const metricsBar = new BoxRenderable(renderer, {
    id: "metrics-bar",
    flexDirection: "row",
    width: "100%",
    height: 1,
    backgroundColor: colors.base,
  });
  root.add(metricsBar);

  // Main content area (horizontal split)
  const mainContent = new BoxRenderable(renderer, {
    id: "main-content",
    flexDirection: "row",
    width: "100%",
    flexGrow: 1,
  });
  root.add(mainContent);

  // Left pane (queues list) - fixed width
  const leftPane = new BoxRenderable(renderer, {
    id: "left-pane",
    flexDirection: "column",
    width: 30,
    minWidth: 20,
    height: "100%",
    backgroundColor: colors.mantle,
    borderStyle: "single",
    borderColor: colors.surface0,
    border: true,
  });
  mainContent.add(leftPane);

  // Right pane (jobs) - flexible width
  const rightPane = new BoxRenderable(renderer, {
    id: "right-pane",
    flexDirection: "column",
    flexGrow: 1,
    height: "100%",
    backgroundColor: colors.mantle,
    borderStyle: "single",
    borderColor: colors.surface0,
    border: true,
  });
  mainContent.add(rightPane);

  // Footer
  const footer = new BoxRenderable(renderer, {
    id: "footer",
    flexDirection: "row",
    width: "100%",
    height: 1,
    backgroundColor: colors.base,
    alignItems: "center",
    paddingLeft: 1,
  });
  root.add(footer);

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: "j/k: navigate | Tab: switch pane | Enter: select | d: delete | r: refresh | q: quit",
    fg: colors.overlay0,
  });
  footer.add(footerText);

  return {
    root,
    header,
    headerTitle,
    headerStatus,
    metricsBar,
    mainContent,
    leftPane,
    rightPane,
    footer,
    footerText,
  };
}

export function updateHeaderStatus(
  headerStatus: TextRenderable,
  connected: boolean,
  error: string | null,
  redisHost?: string,
  redisPort?: number,
): void {
  if (error) {
    headerStatus.content = `Error: ${error}`;
    headerStatus.fg = colors.red;
  } else if (connected && redisHost && redisPort) {
    headerStatus.content = t`${fg(colors.green)("Connected")} ${fg(colors.subtext0)(`${redisHost}:${redisPort}`)}`;
    headerStatus.fg = colors.green;
  } else if (connected) {
    headerStatus.content = "Connected";
    headerStatus.fg = colors.green;
  } else {
    headerStatus.content = "Connecting...";
    headerStatus.fg = colors.yellow;
  }
}
