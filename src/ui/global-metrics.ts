import {
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
  bold,
  StyledText,
} from "@opentui/core";
import type { GlobalMetrics } from "../data/metrics.js";
import { colors } from "./colors.js";
import { concatStyledText } from "./utils.js";

export interface GlobalMetricsElements {
  container: BoxRenderable;
  text: TextRenderable;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

export function createGlobalMetrics(
  renderer: CliRenderer,
  parent: BoxRenderable,
): GlobalMetricsElements {
  // Container for metrics bar
  const container = new BoxRenderable(renderer, {
    id: "global-metrics-container",
    flexDirection: "row",
    width: "100%",
    height: 1,
    backgroundColor: colors.base,
    paddingLeft: 1,
    paddingRight: 1,
    justifyContent: "space-between",
  });
  parent.add(container);

  // Metrics text
  const text = new TextRenderable(renderer, {
    id: "global-metrics-text",
    content: "Loading metrics...",
    fg: colors.overlay0,
  });
  container.add(text);

  return { container, text };
}

export function updateGlobalMetrics(
  elements: GlobalMetricsElements,
  metrics: GlobalMetrics | null,
): void {
  const { text } = elements;

  if (!metrics) {
    text.content = t`${fg(colors.overlay1)("Loading metrics...")}`;
    return;
  }

  const parts: (StyledText | string)[] = [];

  // QUEUES
  parts.push(t`${fg(colors.overlay0)("QUEUES:")}`);
  parts.push(t`${bold(fg(colors.text)(String(metrics.queueCount)))}`);
  parts.push("  ");

  // WAITING - alert if > 100
  const waitColor = metrics.jobCounts.wait > 100 ? colors.red : colors.yellow;
  parts.push(t`${fg(colors.overlay0)("WAIT:")}`);
  parts.push(t`${bold(fg(waitColor)(formatNumber(metrics.jobCounts.wait)))}`);
  parts.push("  ");

  // ACTIVE
  parts.push(t`${fg(colors.overlay0)("ACTIVE:")}`);
  parts.push(t`${bold(fg(colors.green)(formatNumber(metrics.jobCounts.active)))}`);
  parts.push("  ");

  // COMPLETED
  parts.push(t`${fg(colors.overlay0)("DONE:")}`);
  parts.push(t`${bold(fg(colors.blue)(formatNumber(metrics.jobCounts.completed)))}`);
  parts.push("  ");

  // FAILED - alert if > 0 (always red since failures are important)
  const failedColor = metrics.jobCounts.failed > 0 ? colors.red : colors.subtext0;
  parts.push(t`${fg(colors.overlay0)("FAIL:")}`);
  parts.push(t`${bold(fg(failedColor)(formatNumber(metrics.jobCounts.failed)))}`);
  parts.push("  ");

  // DELAYED
  parts.push(t`${fg(colors.overlay0)("DELAY:")}`);
  parts.push(t`${bold(fg(colors.mauve)(formatNumber(metrics.jobCounts.delayed)))}`);
  parts.push("  ");

  // ENQUEUED (jobs added per min/sec) - teal
  parts.push(t`${fg(colors.overlay0)("ENQ:")}`);
  parts.push(t`${bold(fg(colors.teal)(`${Math.round(metrics.rates.enqueuedPerMin)}/m`))}`);
  parts.push(t`${fg(colors.subtext0)(` (${metrics.rates.enqueuedPerSec}/s)`)}`);
  parts.push("  ");

  // DEQUEUED (jobs processed per min/sec) - peach
  parts.push(t`${fg(colors.overlay0)("DEQ:")}`);
  parts.push(t`${bold(fg(colors.peach)(`${Math.round(metrics.rates.dequeuedPerMin)}/m`))}`);
  parts.push(t`${fg(colors.subtext0)(` (${metrics.rates.dequeuedPerSec}/s)`)}`);

  text.content = concatStyledText(...parts);
}
