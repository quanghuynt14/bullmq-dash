import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
} from "@opentui/core";
import type { JobSchedulerSummary } from "../data/schedulers.js";
import { formatNextRun, getScheduleDescription } from "../data/schedulers.js";
import { stateManager } from "../state.js";
import { colors } from "./colors.js";

export interface SchedulerListElements {
  container: BoxRenderable;
  title: TextRenderable;
  select: SelectRenderable;
  emptyText: TextRenderable;
  pagination: TextRenderable;
}

export function createSchedulerList(
  renderer: CliRenderer,
  parent: BoxRenderable,
): SchedulerListElements {
  // Container
  const container = new BoxRenderable(renderer, {
    id: "scheduler-list-container",
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
  });
  container.visible = false;
  parent.add(container);

  // Title / header
  const title = new TextRenderable(renderer, {
    id: "scheduler-list-title",
    content: " SCHEDULERS",
    fg: colors.text,
    bg: colors.surface0,
    width: "100%",
    height: 1,
  });
  container.add(title);

  // Select element for scheduler list
  const select = new SelectRenderable(renderer, {
    id: "scheduler-list-select",
    height: "100%",
    flexGrow: 1,
    options: [],
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    selectedBackgroundColor: colors.surface0,
    textColor: colors.text,
    selectedTextColor: colors.peach,
    descriptionColor: colors.overlay0,
    selectedDescriptionColor: colors.subtext0,
    showScrollIndicator: true,
    wrapSelection: false,
    showDescription: true,
  });
  container.add(select);

  // Empty state text
  const emptyText = new TextRenderable(renderer, {
    id: "scheduler-list-empty",
    content: "No job schedulers found",
    fg: colors.overlay0,
    position: "absolute",
    left: 2,
    top: 2,
  });
  emptyText.visible = false;
  container.add(emptyText);

  // Pagination
  const pagination = new TextRenderable(renderer, {
    id: "scheduler-list-pagination",
    content: "",
    fg: colors.overlay0,
    height: 1,
    alignSelf: "center",
  });
  container.add(pagination);

  // Handle selection change
  select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    const state = stateManager.getState();
    if (state.selectedSchedulerIndex !== index) {
      stateManager.setState({ selectedSchedulerIndex: index });
    }
  });

  return { container, title, select, emptyText, pagination };
}

export function updateSchedulerList(
  elements: SchedulerListElements,
  schedulers: JobSchedulerSummary[],
  selectedIndex: number,
  page: number,
  totalPages: number,
  total: number,
  isFocused: boolean,
): void {
  const { title, select, emptyText, pagination } = elements;

  // Update title to show focus state
  title.content = isFocused ? " SCHEDULERS [*]" : " SCHEDULERS";
  title.bg = isFocused ? colors.surface1 : colors.surface0;

  if (schedulers.length === 0) {
    select.visible = false;
    emptyText.visible = true;
    pagination.content = "";
    return;
  }

  select.visible = true;
  emptyText.visible = false;

  // Convert schedulers to select options
  const options: SelectOption[] = schedulers.map((scheduler) => {
    const schedule = getScheduleDescription(scheduler);
    const nextRun = formatNextRun(scheduler.next);
    const iterations = scheduler.iterationCount ?? 0;

    return {
      name: `${scheduler.key}  ${scheduler.name}`,
      description: `${schedule}  ${nextRun}  (${iterations} runs)`,
      value: scheduler,
    };
  });

  select.options = options;

  // Update selection
  if (select.getSelectedIndex() !== selectedIndex) {
    select.setSelectedIndex(selectedIndex);
  }

  // Focus state
  if (isFocused && !select.focused) {
    select.focus();
  } else if (!isFocused && select.focused) {
    select.blur();
  }

  // Pagination
  pagination.content = `Page ${page}/${totalPages} (${total} total)  <- prev | next -> | g jump`;
}

export function showSchedulerList(elements: SchedulerListElements): void {
  elements.container.visible = true;
}

export function hideSchedulerList(elements: SchedulerListElements): void {
  elements.container.visible = false;
}
