import { type CliRenderer, BoxRenderable, TextRenderable, t, fg, bold } from "@opentui/core";
import { colors } from "./colors.js";

export interface PageJumpElements {
  overlay: BoxRenderable;
  container: BoxRenderable;
  title: TextRenderable;
  input: TextRenderable;
  hint: TextRenderable;
}

export function createPageJump(renderer: CliRenderer): PageJumpElements {
  // Semi-transparent overlay
  const overlay = new BoxRenderable(renderer, {
    id: "page-jump-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    backgroundColor: colors.crust,
    zIndex: 200,
  });
  overlay.visible = false;
  renderer.root.add(overlay);

  // Dialog container
  const container = new BoxRenderable(renderer, {
    id: "page-jump-container",
    position: "absolute",
    left: "30%",
    top: "40%",
    width: 40,
    height: 9,
    backgroundColor: colors.base,
    borderStyle: "rounded",
    borderColor: colors.blue,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 201,
    border: true,
  });
  container.visible = false;
  renderer.root.add(container);

  // Title
  const title = new TextRenderable(renderer, {
    id: "page-jump-title",
    content: t`${bold(fg(colors.text)("Go to Page"))}`,
    fg: colors.text,
    marginTop: 1,
  });
  container.add(title);

  // Input display
  const input = new TextRenderable(renderer, {
    id: "page-jump-input",
    content: "_",
    fg: colors.sky,
    marginTop: 1,
  });
  container.add(input);

  // Hint
  const hint = new TextRenderable(renderer, {
    id: "page-jump-hint",
    content: t`${fg(colors.overlay0)("Enter page number, then press Enter")}`,
    fg: colors.subtext0,
    marginTop: 1,
  });
  container.add(hint);

  return { overlay, container, title, input, hint };
}

export function updatePageJump(
  elements: PageJumpElements,
  visible: boolean,
  inputValue: string,
  currentPage: number,
  totalPages: number,
): void {
  const { overlay, container, input, hint } = elements;

  overlay.visible = visible;
  container.visible = visible;

  if (visible) {
    // Show input with cursor
    const displayValue = inputValue || "";
    input.content = t`${fg(colors.sky)(displayValue)}${fg(colors.overlay0)("_")}`;

    // Update hint with page info
    hint.content = t`${fg(colors.overlay0)(`Current: ${currentPage}/${totalPages} | Esc to cancel`)}`;
  }
}

export function showPageJump(elements: PageJumpElements): void {
  elements.overlay.visible = true;
  elements.container.visible = true;
}

export function hidePageJump(elements: PageJumpElements): void {
  elements.overlay.visible = false;
  elements.container.visible = false;
}
