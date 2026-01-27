import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
  bold,
  StyledText,
} from "@opentui/core";
import type { JobDetail } from "../data/jobs.js";
import { formatTimestamp } from "../data/jobs.js";
import { formatInterval } from "../data/schedulers.js";
import { colors } from "./colors.js";
import { concatStyledText } from "./utils.js";

export interface JobDetailElements {
  overlay: BoxRenderable;
  container: BoxRenderable;
  title: TextRenderable;
  content: TextRenderable;
  footer: TextRenderable;
}

export function createJobDetail(renderer: CliRenderer): JobDetailElements {
  // Semi-transparent overlay
  const overlay = new BoxRenderable(renderer, {
    id: "job-detail-overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    backgroundColor: colors.crust,
    zIndex: 100,
  });
  overlay.visible = false;
  renderer.root.add(overlay);

  // Modal container
  const container = new BoxRenderable(renderer, {
    id: "job-detail-container",
    position: "absolute",
    left: 5,
    top: 2,
    width: "90%",
    height: "90%",
    backgroundColor: colors.base,
    borderStyle: "double",
    borderColor: colors.blue,
    flexDirection: "column",
    zIndex: 101,
    border: true,
  });
  container.visible = false;
  renderer.root.add(container);

  // Title bar
  const title = new TextRenderable(renderer, {
    id: "job-detail-title",
    content: "Job Detail",
    fg: colors.text,
    bg: colors.surface0,
    width: "100%",
    height: 1,
    paddingLeft: 1,
  });
  container.add(title);

  // Content area
  const content = new TextRenderable(renderer, {
    id: "job-detail-content",
    content: "",
    fg: colors.text,
    flexGrow: 1,
    paddingLeft: 1,
    paddingTop: 1,
  });
  container.add(content);

  // Footer
  const footer = new TextRenderable(renderer, {
    id: "job-detail-footer",
    content: "d: delete job | Esc: close",
    fg: colors.overlay0,
    bg: colors.surface0,
    width: "100%",
    height: 1,
    paddingLeft: 1,
  });
  container.add(footer);

  return { overlay, container, title, content, footer };
}

function formatData(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function getStateColor(state: string): string {
  switch (state) {
    case "active":
      return colors.green;
    case "waiting":
    case "wait":
      return colors.yellow;
    case "completed":
      return colors.blue;
    case "failed":
      return colors.red;
    case "delayed":
      return colors.mauve;
    default:
      return colors.subtext0;
  }
}

export function updateJobDetail(
  elements: JobDetailElements,
  job: JobDetail | null,
  visible: boolean,
): void {
  const { overlay, container, title, content } = elements;

  overlay.visible = visible;
  container.visible = visible;

  if (!job || !visible) {
    return;
  }

  // Update title
  title.content = t` Job: ${bold(fg(colors.text)(job.id))}`;

  // Build content using StyledText concatenation
  const stateColor = getStateColor(job.state);
  const parts: (StyledText | string)[] = [];

  parts.push(t`${bold("ID:")}          ${job.id}`);
  parts.push("\n");
  parts.push(t`${bold("Name:")}        ${job.name}`);
  parts.push("\n");
  parts.push(t`${bold("State:")}       ${fg(stateColor)(job.state)}`);
  parts.push("\n");
  parts.push(t`${bold("Attempts:")}    ${String(job.attemptsMade)}`);
  parts.push("\n");
  parts.push(t`${bold("Created:")}     ${formatTimestamp(job.timestamp)}`);

  if (job.processedOn) {
    parts.push("\n");
    parts.push(t`${bold("Processed:")}   ${formatTimestamp(job.processedOn)}`);
  }

  if (job.finishedOn) {
    parts.push("\n");
    parts.push(t`${bold("Finished:")}    ${formatTimestamp(job.finishedOn)}`);
  }

  // Show scheduler info if this job was created by a scheduler (repeatable job)
  if (job.repeatJobKey) {
    parts.push("\n\n");
    parts.push(t`${bold(fg(colors.peach)("Scheduler Info:"))}`);
    parts.push("\n");
    parts.push(t`${bold("Scheduler:")}   ${fg(colors.peach)(job.repeatJobKey)}`);

    // Try to extract repeat info from opts
    const opts = job.opts as {
      repeat?: { pattern?: string; every?: number };
      delay?: number;
    } | null;
    if (opts?.repeat?.pattern) {
      parts.push("\n");
      parts.push(t`${bold("Pattern:")}     ${fg(colors.green)(opts.repeat.pattern)}`);
    }
    if (opts?.repeat?.every) {
      parts.push("\n");
      parts.push(t`${bold("Interval:")}    ${fg(colors.green)(formatInterval(opts.repeat.every))}`);
    }
  }

  // Show delay info if present
  if (job.delay && job.delay > 0) {
    parts.push("\n");
    parts.push(t`${bold("Delay:")}       ${formatInterval(job.delay)}`);
  }

  parts.push("\n\n");
  parts.push(t`${bold("Data:")}`);
  parts.push("\n");
  parts.push(formatData(job.data));

  if (job.returnvalue !== undefined) {
    parts.push("\n\n");
    parts.push(t`${bold("Return Value:")}`);
    parts.push("\n");
    parts.push(formatData(job.returnvalue));
  }

  if (job.failedReason) {
    parts.push("\n\n");
    parts.push(t`${bold(fg(colors.red)("Error:"))}`);
    parts.push("\n");
    parts.push(t`${fg(colors.red)(job.failedReason)}`);
  }

  if (job.stacktrace && job.stacktrace.length > 0) {
    parts.push("\n\n");
    parts.push(t`${bold(fg(colors.red)("Stacktrace:"))}`);
    for (const line of job.stacktrace) {
      parts.push("\n");
      parts.push(t`${fg(colors.overlay0)(line)}`);
    }
  }

  content.content = concatStyledText(...parts);
}

export function showJobDetail(elements: JobDetailElements): void {
  elements.overlay.visible = true;
  elements.container.visible = true;
}

export function hideJobDetail(elements: JobDetailElements): void {
  elements.overlay.visible = false;
  elements.container.visible = false;
}
