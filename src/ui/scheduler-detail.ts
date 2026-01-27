import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
  bold,
  StyledText,
} from "@opentui/core";
import type { JobSchedulerDetail, RecentJobInfo } from "../data/schedulers.js";
import { formatInterval, formatSchedulerTimestamp, formatNextRun } from "../data/schedulers.js";
import { colors } from "./colors.js";
import { concatStyledText } from "./utils.js";

export interface SchedulerDetailElements {
  overlay: BoxRenderable;
  container: BoxRenderable;
  title: TextRenderable;
  content: TextRenderable;
  footer: TextRenderable;
}

export function createSchedulerDetail(renderer: CliRenderer): SchedulerDetailElements {
  // Semi-transparent overlay
  const overlay = new BoxRenderable(renderer, {
    id: "scheduler-detail-overlay",
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
    id: "scheduler-detail-container",
    position: "absolute",
    left: 5,
    top: 2,
    width: "90%",
    height: "90%",
    backgroundColor: colors.base,
    borderStyle: "double",
    borderColor: colors.peach,
    flexDirection: "column",
    zIndex: 101,
    border: true,
  });
  container.visible = false;
  renderer.root.add(container);

  // Title bar
  const title = new TextRenderable(renderer, {
    id: "scheduler-detail-title",
    content: "Scheduler Detail",
    fg: colors.text,
    bg: colors.surface0,
    width: "100%",
    height: 1,
    paddingLeft: 1,
  });
  container.add(title);

  // Content area
  const content = new TextRenderable(renderer, {
    id: "scheduler-detail-content",
    content: "",
    fg: colors.text,
    flexGrow: 1,
    paddingLeft: 1,
    paddingTop: 1,
  });
  container.add(content);

  // Footer
  const footer = new TextRenderable(renderer, {
    id: "scheduler-detail-footer",
    content: "j: view next job | Esc: close",
    fg: colors.overlay0,
    bg: colors.surface0,
    width: "100%",
    height: 1,
    paddingLeft: 1,
  });
  container.add(footer);

  return { overlay, container, title, content, footer };
}

function formatData(data: unknown, maxLength: number = 500): string {
  try {
    const json = JSON.stringify(data, null, 2);
    if (json.length > maxLength) {
      return json.slice(0, maxLength) + "\n  ...";
    }
    return json;
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

function formatDuration(startMs: number | undefined, endMs: number | undefined): string {
  if (!startMs || !endMs) return "";
  const durationMs = endMs - startMs;
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60000).toFixed(1)}m`;
}

function formatRecentJob(job: RecentJobInfo): StyledText {
  const stateColor = getStateColor(job.state);
  const duration = formatDuration(job.processedOn, job.finishedOn);
  const durationStr = duration ? ` (${duration})` : "";
  const timestamp = formatSchedulerTimestamp(job.finishedOn || job.timestamp);
  
  if (job.state === "failed" && job.failedReason) {
    const shortReason = job.failedReason.length > 30 
      ? job.failedReason.slice(0, 30) + "..." 
      : job.failedReason;
    return t`  ${fg(colors.overlay0)(`#${job.id}`)} ${fg(stateColor)(job.state)}  ${timestamp}  ${fg(colors.red)(shortReason)}`;
  }
  
  return t`  ${fg(colors.overlay0)(`#${job.id}`)} ${fg(stateColor)(job.state)}  ${timestamp}${durationStr}`;
}

export function updateSchedulerDetail(
  elements: SchedulerDetailElements,
  scheduler: JobSchedulerDetail | null,
  visible: boolean,
): void {
  const { overlay, container, title, content, footer } = elements;

  overlay.visible = visible;
  container.visible = visible;

  if (!scheduler || !visible) {
    return;
  }

  // Update title
  title.content = t` Scheduler: ${bold(fg(colors.text)(scheduler.key))}`;

  // Update footer based on whether there's a next job
  footer.content = scheduler.nextJob 
    ? "j: view next job | Esc: close"
    : "Esc: close";

  // Build content using StyledText concatenation
  const parts: (StyledText | string)[] = [];

  parts.push(t`${bold("Key:")}            ${scheduler.key}`);
  parts.push("\n");
  parts.push(t`${bold("Name:")}           ${scheduler.name}`);

  if (scheduler.id) {
    parts.push("\n");
    parts.push(t`${bold("ID:")}             ${scheduler.id}`);
  }

  parts.push("\n\n");
  parts.push(t`${bold(fg(colors.peach)("Schedule:"))}`);
  parts.push("\n");

  if (scheduler.pattern) {
    parts.push(t`${bold("Pattern:")}        ${fg(colors.green)(scheduler.pattern)}`);
    parts.push("\n");
  }

  if (scheduler.every) {
    parts.push(t`${bold("Interval:")}       ${fg(colors.green)(formatInterval(scheduler.every))}`);
    parts.push("\n");
  }

  if (scheduler.tz) {
    parts.push(t`${bold("Timezone:")}       ${scheduler.tz}`);
    parts.push("\n");
  }

  if (scheduler.next) {
    parts.push(t`${bold("Next Run:")}       ${formatSchedulerTimestamp(scheduler.next)}`);
    parts.push("\n");
  }

  parts.push("\n");
  parts.push(t`${bold(fg(colors.sky)("Statistics:"))}`);
  parts.push("\n");

  parts.push(t`${bold("Iterations:")}     ${String(scheduler.iterationCount ?? 0)}`);
  if (scheduler.limit) {
    parts.push(t` / ${String(scheduler.limit)}`);
  }
  parts.push("\n");

  if (scheduler.startDate) {
    parts.push(t`${bold("Start Date:")}     ${formatSchedulerTimestamp(scheduler.startDate)}`);
    parts.push("\n");
  }

  if (scheduler.endDate) {
    parts.push(t`${bold("End Date:")}       ${formatSchedulerTimestamp(scheduler.endDate)}`);
    parts.push("\n");
  }

  // Job Template Section
  if (scheduler.template) {
    parts.push("\n");
    parts.push(t`${bold(fg(colors.mauve)("Job Template:"))}`);

    if (scheduler.template.data !== undefined) {
      parts.push("\n");
      parts.push(t`${bold("Data:")}`);
      parts.push("\n");
      parts.push(formatData(scheduler.template.data));
    }

    if (scheduler.template.opts !== undefined) {
      parts.push("\n\n");
      parts.push(t`${bold("Options:")}`);
      parts.push("\n");
      parts.push(formatData(scheduler.template.opts));
    }
  }

  // Next Delayed Job Section
  parts.push("\n\n");
  parts.push(t`${bold(fg(colors.yellow)("Next Delayed Job:"))}`);
  parts.push("\n");

  if (scheduler.nextJob) {
    const stateColor = getStateColor(scheduler.nextJob.state);
    parts.push(t`${bold("ID:")}             ${scheduler.nextJob.id}`);
    parts.push("\n");
    parts.push(t`${bold("State:")}          ${fg(stateColor)(scheduler.nextJob.state)}`);
    parts.push("\n");
    
    if (scheduler.next) {
      parts.push(t`${bold("Runs:")}           ${fg(colors.green)(formatNextRun(scheduler.next))}`);
      parts.push("\n");
    }

    if (scheduler.nextJob.data !== undefined) {
      parts.push(t`${bold("Data:")}`);
      parts.push("\n");
      parts.push(formatData(scheduler.nextJob.data, 300));
    }
  } else {
    parts.push(t`${fg(colors.overlay0)("No pending job")}`);
  }

  // Recent History Section
  parts.push("\n\n");
  parts.push(t`${bold(fg(colors.lavender)("Recent History:"))}`);
  parts.push("\n");

  if (scheduler.recentJobs && scheduler.recentJobs.length > 0) {
    for (const job of scheduler.recentJobs.slice(0, 5)) {
      parts.push(formatRecentJob(job));
      parts.push("\n");
    }
    if (scheduler.recentJobs.length > 5) {
      parts.push(t`  ${fg(colors.overlay0)(`... and ${scheduler.recentJobs.length - 5} more`)}`);
    }
  } else {
    parts.push(t`${fg(colors.overlay0)("No history yet")}`);
  }

  content.content = concatStyledText(...parts);
}

export function showSchedulerDetail(elements: SchedulerDetailElements): void {
  elements.overlay.visible = true;
  elements.container.visible = true;
}

export function hideSchedulerDetail(elements: SchedulerDetailElements): void {
  elements.overlay.visible = false;
  elements.container.visible = false;
}
