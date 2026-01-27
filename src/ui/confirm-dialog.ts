import { type CliRenderer, BoxRenderable, TextRenderable, t, fg, bold } from "@opentui/core";
import { colors } from "./colors.js";

export interface ConfirmDialogElements {
  overlay: BoxRenderable;
  container: BoxRenderable;
  message: TextRenderable;
  buttons: TextRenderable;
}

export function createConfirmDialog(renderer: CliRenderer): ConfirmDialogElements {
  // Semi-transparent overlay
  const overlay = new BoxRenderable(renderer, {
    id: "confirm-dialog-overlay",
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
    id: "confirm-dialog-container",
    position: "absolute",
    left: "30%",
    top: "40%",
    width: 40,
    height: 7,
    backgroundColor: colors.base,
    borderStyle: "double",
    borderColor: colors.red,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 201,
    border: true,
  });
  container.visible = false;
  renderer.root.add(container);

  // Message
  const message = new TextRenderable(renderer, {
    id: "confirm-dialog-message",
    content: t`${bold(fg(colors.text)("Delete this job?"))}`,
    fg: colors.text,
    marginTop: 1,
  });
  container.add(message);

  // Buttons hint
  const buttons = new TextRenderable(renderer, {
    id: "confirm-dialog-buttons",
    content: t`${fg(colors.green)("[y] Yes")}    ${fg(colors.red)("[n] No")}`,
    fg: colors.subtext0,
    marginTop: 1,
  });
  container.add(buttons);

  return { overlay, container, message, buttons };
}

export function showConfirmDialog(elements: ConfirmDialogElements, jobId: string): void {
  const { overlay, container, message } = elements;

  message.content = t`${bold(fg(colors.text)(`Delete job ${jobId}?`))}`;

  overlay.visible = true;
  container.visible = true;
}

export function hideConfirmDialog(elements: ConfirmDialogElements): void {
  elements.overlay.visible = false;
  elements.container.visible = false;
}
