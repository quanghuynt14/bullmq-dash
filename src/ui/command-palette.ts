import { type CliRenderer, BoxRenderable, TextRenderable, t, fg, bold } from "@opentui/core";
import { colors } from "./colors.js";

/**
 * A palette entry. The runnable half lives in app.ts (actions close over the
 * polling/state managers); this module only knows how to filter and render.
 */
export interface PaletteAction {
  id: string;
  title: string;
  /** Related direct keyboard shortcut, shown right-aligned. */
  hint?: string;
}

/** Case-insensitive substring filter on action titles. Empty query = all. */
export function filterPaletteActions<T extends PaletteAction>(actions: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return actions;
  return actions.filter((action) => action.title.toLowerCase().includes(needle));
}

/**
 * Clamp a selection index to a filtered list, returning 0 for empty lists.
 * Exported so the key handler and the renderer agree on the effective index.
 */
export function clampPaletteIndex(index: number, listLength: number): number {
  if (listLength <= 0) return 0;
  return Math.max(0, Math.min(index, listLength - 1));
}

const MAX_VISIBLE_ACTIONS = 10;
const PALETTE_WIDTH = 56;

export interface CommandPaletteElements {
  overlay: BoxRenderable;
  container: BoxRenderable;
  input: TextRenderable;
  rows: TextRenderable[];
  hint: TextRenderable;
}

export function createCommandPalette(renderer: CliRenderer): CommandPaletteElements {
  const overlay = new BoxRenderable(renderer, {
    id: "command-palette-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    backgroundColor: colors.crust,
    zIndex: 210,
  });
  overlay.visible = false;
  renderer.root.add(overlay);

  const container = new BoxRenderable(renderer, {
    id: "command-palette-container",
    position: "absolute",
    left: "25%",
    top: 4,
    width: PALETTE_WIDTH,
    height: MAX_VISIBLE_ACTIONS + 5,
    backgroundColor: colors.base,
    borderStyle: "rounded",
    borderColor: colors.mauve,
    flexDirection: "column",
    zIndex: 211,
    border: true,
    paddingLeft: 1,
    paddingRight: 1,
  });
  container.visible = false;
  renderer.root.add(container);

  const input = new TextRenderable(renderer, {
    id: "command-palette-input",
    content: t`${bold(fg(colors.mauve)(">"))} ${fg(colors.overlay0)("▌")}`,
    fg: colors.text,
  });
  container.add(input);

  const rows: TextRenderable[] = [];
  for (let i = 0; i < MAX_VISIBLE_ACTIONS; i++) {
    const row = new TextRenderable(renderer, {
      id: `command-palette-row-${i}`,
      content: "",
      fg: colors.text,
      width: "100%",
      marginTop: i === 0 ? 1 : 0,
    });
    container.add(row);
    rows.push(row);
  }

  const hint = new TextRenderable(renderer, {
    id: "command-palette-hint",
    content: t`${fg(colors.overlay0)("↑/↓ navigate | Enter: run | Esc: close")}`,
    marginTop: 1,
  });
  container.add(hint);

  return { overlay, container, input, rows, hint };
}

export function updateCommandPalette(
  elements: CommandPaletteElements,
  visible: boolean,
  query: string,
  actions: PaletteAction[],
  selectedIndex: number,
): void {
  const { overlay, container, input, rows, hint } = elements;

  overlay.visible = visible;
  container.visible = visible;
  if (!visible) return;

  input.content = t`${bold(fg(colors.mauve)(">"))} ${fg(colors.sky)(query)}${fg(colors.overlay0)("▌")}`;

  const effectiveIndex = clampPaletteIndex(selectedIndex, actions.length);
  // Scroll the visible window so the selection stays on screen.
  const offset = Math.max(0, effectiveIndex - MAX_VISIBLE_ACTIONS + 1);
  const visibleActions = actions.slice(offset, offset + MAX_VISIBLE_ACTIONS);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const action = visibleActions[i];
    if (!action) {
      row.content =
        i === 0 && actions.length === 0 ? t`${fg(colors.overlay0)("  No matching commands")}` : "";
      row.bg = "transparent";
      continue;
    }
    const isSelected = offset + i === effectiveIndex;
    const marker = isSelected ? "▶ " : "  ";
    const hintText = action.hint ? ` (${action.hint})` : "";
    const titleWidth = PALETTE_WIDTH - 4 - marker.length - hintText.length;
    const title =
      action.title.length > titleWidth ? `${action.title.slice(0, titleWidth - 1)}…` : action.title;
    row.content = isSelected
      ? t`${bold(fg(colors.sky)(`${marker}${title}`))}${fg(colors.overlay0)(hintText)}`
      : t`${fg(colors.text)(`${marker}${title}`)}${fg(colors.overlay0)(hintText)}`;
    row.bg = isSelected ? colors.surface0 : "transparent";
  }

  const total = actions.length;
  hint.content = t`${fg(colors.overlay0)(`${total} command${total === 1 ? "" : "s"} | ↑/↓ | Enter: run | Esc: close`)}`;
}
