import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
} from "@opentui/core";
import type { QueueStats } from "../data/queues.js";
import { stateManager } from "../state.js";
import { pollingManager } from "../polling.js";
import { colors } from "./colors.js";

export interface QueueListElements {
  container: BoxRenderable;
  title: TextRenderable;
  select: SelectRenderable;
  emptyText: TextRenderable;
}

export function createQueueList(renderer: CliRenderer, parent: BoxRenderable): QueueListElements {
  // Container
  const container = new BoxRenderable(renderer, {
    id: "queue-list-container",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  parent.add(container);

  // Title
  const title = new TextRenderable(renderer, {
    id: "queue-list-title",
    content: " QUEUES",
    fg: colors.text,
    bg: colors.surface0,
    width: "100%",
    height: 1,
  });
  container.add(title);

  // Select element for queue list
  const select = new SelectRenderable(renderer, {
    id: "queue-list-select",
    height: "100%",
    flexGrow: 1,
    options: [],
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    selectedBackgroundColor: colors.surface0,
    textColor: colors.text,
    selectedTextColor: colors.sky,
    descriptionColor: colors.overlay0,
    selectedDescriptionColor: colors.subtext0,
    showScrollIndicator: true,
    wrapSelection: false,
    showDescription: true,
  });
  container.add(select);

  // Empty state text
  const emptyText = new TextRenderable(renderer, {
    id: "queue-list-empty",
    content: "No queues found",
    fg: colors.overlay0,
    position: "absolute",
    left: 2,
    top: 2,
  });
  emptyText.visible = false;
  container.add(emptyText);

  // Handle selection change from SelectRenderable's internal navigation
  select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    const state = stateManager.getState();
    if (state.selectedQueueIndex !== index) {
      stateManager.setState({
        selectedQueueIndex: index,
        selectedJobIndex: 0,
        jobsPage: 1,
      });
      // Only refresh jobs for the newly selected queue (fast)
      pollingManager.refreshJobs();
    }
  });

  return { container, title, select, emptyText };
}

export function updateQueueList(
  elements: QueueListElements,
  queues: QueueStats[],
  selectedIndex: number,
  isFocused: boolean,
): void {
  const { select, emptyText, title } = elements;

  // Update title to show focus state
  title.content = isFocused ? " QUEUES [*]" : " QUEUES";
  title.bg = isFocused ? colors.surface1 : colors.surface0;

  if (queues.length === 0) {
    select.visible = false;
    emptyText.visible = true;
    return;
  }

  select.visible = true;
  emptyText.visible = false;

  // Convert queues to select options
  const options: SelectOption[] = queues.map((queue) => ({
    name: queue.name,
    description: `${queue.total} jobs | ${queue.isPaused ? "PAUSED" : "active"}`,
    value: queue,
  }));

  select.options = options;

  // Update selection (without triggering event)
  if (select.getSelectedIndex() !== selectedIndex) {
    select.setSelectedIndex(selectedIndex);
  }

  // Focus state
  if (isFocused && !select.focused) {
    select.focus();
  } else if (!isFocused && select.focused) {
    select.blur();
  }
}
