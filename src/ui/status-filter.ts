import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
  bold,
  StyledText,
} from "@opentui/core";
import type { JobListView } from "../data/jobs.js";
import { colors } from "./colors.js";
import { concatStyledText } from "./utils.js";

export interface StatusFilterElements {
  container: BoxRenderable;
  text: TextRenderable;
}

const STATUS_OPTIONS: { key: string; status: JobListView; label: string }[] = [
  { key: "1", status: "latest", label: "latest" },
  { key: "2", status: "wait", label: "wait" },
  { key: "3", status: "active", label: "active" },
  { key: "4", status: "completed", label: "completed" },
  { key: "5", status: "failed", label: "failed" },
  { key: "6", status: "delayed", label: "delayed" },
  { key: "7", status: "schedulers", label: "schedulers" },
];

export function createStatusFilter(
  renderer: CliRenderer,
  parent: BoxRenderable,
): StatusFilterElements {
  // Container
  const container = new BoxRenderable(renderer, {
    id: "status-filter-container",
    flexDirection: "row",
    width: "100%",
    height: 1,
    paddingLeft: 1,
    backgroundColor: colors.base,
  });
  parent.add(container);

  // Status text
  const text = new TextRenderable(renderer, {
    id: "status-filter-text",
    content: "",
    fg: colors.overlay0,
  });
  container.add(text);

  return { container, text };
}

export function updateStatusFilter(elements: StatusFilterElements, currentStatus: JobListView): void {
  const { text } = elements;

  // Build parts with separators between them
  const parts: (StyledText | string)[] = [];

  STATUS_OPTIONS.forEach(({ key, status, label }, index) => {
    const isSelected = status === currentStatus;
    if (isSelected) {
      parts.push(t`${bold(fg(colors.sky)(`[${key}:${label}]`))}`);
    } else {
      parts.push(t`${fg(colors.overlay0)(`${key}:${label}`)}`);
    }
    // Add separator between options (but not after the last one)
    if (index < STATUS_OPTIONS.length - 1) {
      parts.push("  ");
    }
  });

  text.content = concatStyledText(...parts);
}

export function getStatusFromKey(key: string): JobListView | null {
  const option = STATUS_OPTIONS.find((o) => o.key === key);
  return option?.status ?? null;
}
