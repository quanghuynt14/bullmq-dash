import { type CliRenderer, BoxRenderable, TextRenderable, t, fg, bold } from "@opentui/core";
import type { QueueStats } from "../data/queues.js";
import { colors } from "./colors.js";

export interface QueueStatsElements {
  container: BoxRenderable;
  title: TextRenderable;
  statsText: TextRenderable;
}

export function createQueueStats(renderer: CliRenderer, parent: BoxRenderable): QueueStatsElements {
  // Container
  const container = new BoxRenderable(renderer, {
    id: "queue-stats-container",
    flexDirection: "column",
    width: "100%",
    height: 4,
    paddingLeft: 1,
    paddingRight: 1,
    borderStyle: "single",
    borderColor: colors.surface0,
    border: true,
  });
  parent.add(container);

  // Queue name title
  const title = new TextRenderable(renderer, {
    id: "queue-stats-title",
    content: "Select a queue",
    fg: colors.text,
  });
  container.add(title);

  // Stats line
  const statsText = new TextRenderable(renderer, {
    id: "queue-stats-text",
    content: "",
    fg: colors.subtext0,
  });
  container.add(statsText);

  return { container, title, statsText };
}

export function updateQueueStats(elements: QueueStatsElements, queue: QueueStats | null): void {
  const { title, statsText } = elements;

  if (!queue) {
    title.content = "Select a queue";
    statsText.content = "";
    return;
  }

  // Queue name with paused indicator
  const pausedIndicator = queue.isPaused ? " [PAUSED]" : "";
  title.content = t`${bold(fg(colors.text)(queue.name))}${fg(colors.red)(pausedIndicator)}`;

  // Stats line with colored counts
  const { counts } = queue;
  statsText.content = t`${fg(colors.yellow)(`wait: ${counts.wait}`)}  ${fg(colors.green)(`active: ${counts.active}`)}  ${fg(colors.blue)(`completed: ${counts.completed}`)}  ${fg(colors.red)(`failed: ${counts.failed}`)}  ${fg(colors.mauve)(`delayed: ${counts.delayed}`)}  ${fg(colors.maroon)(`schedulers: ${counts.schedulers}`)}`;
}
