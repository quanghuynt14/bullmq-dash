import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
} from "@opentui/core";
import type { JobSummary } from "../data/jobs.js";
import { formatRelativeTime } from "../data/jobs.js";
import { stateManager } from "../state.js";
import { colors } from "./colors.js";

export interface JobListElements {
  container: BoxRenderable;
  title: TextRenderable;
  select: SelectRenderable;
  emptyText: TextRenderable;
  pagination: TextRenderable;
}

export function createJobList(renderer: CliRenderer, parent: BoxRenderable): JobListElements {
  // Container
  const container = new BoxRenderable(renderer, {
    id: "job-list-container",
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
  });
  parent.add(container);

  // Title / header
  const title = new TextRenderable(renderer, {
    id: "job-list-title",
    content: " JOBS",
    fg: colors.text,
    bg: colors.surface0,
    width: "100%",
    height: 1,
  });
  container.add(title);

  // Select element for job list
  const select = new SelectRenderable(renderer, {
    id: "job-list-select",
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
    id: "job-list-empty",
    content: "No jobs found",
    fg: colors.overlay0,
    position: "absolute",
    left: 2,
    top: 2,
  });
  emptyText.visible = false;
  container.add(emptyText);

  // Pagination
  const pagination = new TextRenderable(renderer, {
    id: "job-list-pagination",
    content: "",
    fg: colors.overlay0,
    height: 1,
    alignSelf: "center",
  });
  container.add(pagination);

  // Handle selection change
  select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    const state = stateManager.getState();
    if (state.selectedJobIndex !== index) {
      stateManager.setState({ selectedJobIndex: index });
    }
  });

  return { container, title, select, emptyText, pagination };
}

export function updateJobList(
  elements: JobListElements,
  jobs: JobSummary[],
  selectedIndex: number,
  page: number,
  totalPages: number,
  total: number,
  isFocused: boolean,
): void {
  const { title, select, emptyText, pagination } = elements;

  // Update title to show focus state
  title.content = isFocused ? " JOBS [*]" : " JOBS";
  title.bg = isFocused ? colors.surface1 : colors.surface0;

  if (jobs.length === 0) {
    select.visible = false;
    emptyText.visible = true;
    pagination.content = "";
    return;
  }

  select.visible = true;
  emptyText.visible = false;

  // Convert jobs to select options
  // Note: SelectOption.description must be a string, so we can't use styled text here
  // Colors are controlled by descriptionColor/selectedDescriptionColor props
  const options: SelectOption[] = jobs.map((job) => {
    const timeAgo = formatRelativeTime(job.timestamp);

    return {
      name: `${job.id}  ${job.name}`,
      description: `${job.state}  ${timeAgo}`,
      value: job,
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
  pagination.content = `Page ${page}/${totalPages} (${total} total)  ← prev | next → | g jump`;
}
