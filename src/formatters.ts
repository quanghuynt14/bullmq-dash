import type { QueueStats } from "./data/queues.js";
import type { JobSummary, JobDetail, RetryResult } from "./data/jobs.js";
import type { JobSchedulerSummary, JobSchedulerDetail, RecentJobInfo } from "./data/schedulers.js";
import { formatInterval } from "./data/schedulers.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function formatTs(ts: number | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Render a table from rows of strings.
 * First row is treated as the header.
 * `align` array: 'l' = left (default), 'r' = right.
 */
function table(headers: string[], rows: string[][], align?: ("l" | "r")[]): string {
  const cols = headers.length;
  const widths: number[] = headers.map((h) => h.length);

  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      widths[i] = Math.max(widths[i]!, (row[i] ?? "").length);
    }
  }

  const pad = (val: string, i: number) => {
    const width = widths[i]!;
    return (align?.[i] ?? "l") === "r" ? val.padStart(width) : val.padEnd(width);
  };

  const headerLine = headers.map(pad).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const bodyLines = rows.map((row) => row.map((val, i) => pad(val, i)).join("  "));

  return [headerLine, separator, ...bodyLines].join("\n");
}

function prettyJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// ── Queues overview ─────────────────────────────────────────────────────

interface QueuesOverviewData {
  timestamp: string;
  queues: QueueStats[];
  metrics: {
    queueCount: number;
    jobCounts: {
      wait: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      total: number;
    };
  };
}

export function formatQueuesOverview(data: QueuesOverviewData): string {
  const headers = ["Queue", "Wait", "Active", "Completed", "Failed", "Delayed", "Total", "Paused"];
  const align: ("l" | "r")[] = ["l", "r", "r", "r", "r", "r", "r", "l"];

  const rows = data.queues.map((q) => [
    q.name,
    String(q.counts.wait),
    String(q.counts.active),
    String(q.counts.completed),
    String(q.counts.failed),
    String(q.counts.delayed),
    String(q.total),
    q.isPaused ? "yes" : "no",
  ]);

  const jc = data.metrics.jobCounts;
  const totals = [
    `Total (${data.metrics.queueCount} queues)`,
    String(jc.wait),
    String(jc.active),
    String(jc.completed),
    String(jc.failed),
    String(jc.delayed),
    String(jc.total),
    "",
  ];

  const allRows = [...rows, totals];
  const tbl = table(headers, allRows, align);

  // Insert a separator line before the totals row
  const lines = tbl.split("\n");
  const sepLine = lines[1]!; // reuse the header separator style
  lines.splice(lines.length - 1, 0, sepLine);

  return lines.join("\n");
}

interface QueuesDeleteData {
  timestamp: string;
  queue: string;
  deleted: boolean;
  dryRun: boolean;
  jobCounts: {
    wait: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  totalJobs: number;
}

export function formatQueuesDelete(data: QueuesDeleteData): string {
  const lines: string[] = [];

  if (data.dryRun) {
    lines.push(`[DRY RUN] Would delete queue '${data.queue}' with ${data.totalJobs} jobs:`);
  } else {
    lines.push(`Deleted queue '${data.queue}' with ${data.totalJobs} jobs:`);
  }

  lines.push("");
  lines.push(`  Wait:      ${data.jobCounts.wait}`);
  lines.push(`  Active:    ${data.jobCounts.active}`);
  lines.push(`  Completed: ${data.jobCounts.completed}`);
  lines.push(`  Failed:    ${data.jobCounts.failed}`);
  lines.push(`  Delayed:   ${data.jobCounts.delayed}`);
  lines.push(`  ─────────────`);
  lines.push(`  Total:     ${data.totalJobs}`);

  if (data.dryRun) {
    lines.push("");
    lines.push("(dry run - no changes made)");
  }

  return lines.join("\n");
}

// ── Jobs list ───────────────────────────────────────────────────────────

interface JobsListData {
  timestamp: string;
  queue: string;
  jobState: string;
  jobs: JobSummary[];
  total: number;
}

export function formatJobsList(data: JobsListData): string {
  const header = `Queue: ${data.queue} | State: ${data.jobState} | ${data.total} jobs`;
  const columns = ["ID", "Name", "State", "Timestamp"];
  const align: ("l" | "r")[] = ["l", "l", "l", "l"];

  const rows = data.jobs.map((j) => [j.id, j.name, j.state, formatTs(j.timestamp)]);

  return [header, "", table(columns, rows, align)].join("\n");
}

// ── Job detail ──────────────────────────────────────────────────────────

interface JobDetailData {
  timestamp: string;
  queue: string;
  job: JobDetail;
}

export function formatJobDetail(data: JobDetailData): string {
  const j = data.job;
  const lines: string[] = [];

  lines.push(`Queue: ${data.queue} | Job: ${j.id}`);
  lines.push("");
  lines.push(`Name:           ${j.name}`);
  lines.push(`State:          ${j.state}`);
  lines.push(`Timestamp:      ${formatTs(j.timestamp)}`);
  if (j.processedOn) lines.push(`Processed:      ${formatTs(j.processedOn)}`);
  if (j.finishedOn) lines.push(`Finished:       ${formatTs(j.finishedOn)}`);
  lines.push(`Attempts:       ${j.attemptsMade}`);
  if (j.delay) lines.push(`Delay:          ${j.delay}ms`);
  if (j.progress !== undefined) lines.push(`Progress:       ${prettyJson(j.progress)}`);
  if (j.failedReason) lines.push(`Failed Reason:  ${j.failedReason}`);
  if (j.repeatJobKey) lines.push(`Repeat Key:     ${j.repeatJobKey}`);

  lines.push("");
  lines.push("Data:");
  lines.push(prettyJson(j.data));

  if (j.returnvalue !== undefined) {
    lines.push("");
    lines.push("Return Value:");
    lines.push(prettyJson(j.returnvalue));
  }

  if (j.stacktrace && j.stacktrace.length > 0) {
    lines.push("");
    lines.push("Stacktrace:");
    for (const line of j.stacktrace) {
      lines.push(`  ${line}`);
    }
  }

  if (j.opts !== undefined) {
    lines.push("");
    lines.push("Options:");
    lines.push(prettyJson(j.opts));
  }

  return lines.join("\n");
}

// ── Schedulers list ─────────────────────────────────────────────────────

interface SchedulersListData {
  timestamp: string;
  queue: string;
  schedulers: JobSchedulerSummary[];
  total: number;
}

function scheduleStr(s: JobSchedulerSummary): string {
  if (s.pattern) return s.pattern;
  if (s.every) return `every ${formatInterval(s.every)}`;
  return "-";
}

export function formatSchedulersList(data: SchedulersListData): string {
  const header = `Queue: ${data.queue} | ${data.total} schedulers`;
  const columns = ["Key", "Name", "Schedule", "Next Run", "Iterations", "TZ"];
  const align: ("l" | "r")[] = ["l", "l", "l", "l", "r", "l"];

  const rows = data.schedulers.map((s) => [
    s.key,
    s.name,
    scheduleStr(s),
    formatTs(s.next),
    s.iterationCount !== undefined ? String(s.iterationCount) : "-",
    s.tz ?? "-",
  ]);

  return [header, "", table(columns, rows, align)].join("\n");
}

// ── Scheduler detail ────────────────────────────────────────────────────

interface SchedulerDetailData {
  timestamp: string;
  queue: string;
  scheduler: JobSchedulerDetail;
}

export function formatSchedulerDetail(data: SchedulerDetailData): string {
  const s = data.scheduler;
  const lines: string[] = [];

  lines.push(`Queue: ${data.queue} | Scheduler: ${s.key}`);
  lines.push("");
  lines.push(`Name:           ${s.name}`);
  if (s.pattern) lines.push(`Pattern:        ${s.pattern}`);
  if (s.every) lines.push(`Every:          ${formatInterval(s.every)}`);
  lines.push(`Next:           ${formatTs(s.next)}`);
  if (s.iterationCount !== undefined) lines.push(`Iterations:     ${s.iterationCount}`);
  if (s.tz) lines.push(`Timezone:       ${s.tz}`);
  if (s.id) lines.push(`ID:             ${s.id}`);
  if (s.limit !== undefined) lines.push(`Limit:          ${s.limit}`);
  if (s.startDate) lines.push(`Start Date:     ${formatTs(s.startDate)}`);
  if (s.endDate) lines.push(`End Date:       ${formatTs(s.endDate)}`);

  if (s.template) {
    lines.push("");
    lines.push("Template:");
    if (s.template.data !== undefined) {
      lines.push("  Data:");
      lines.push("  " + prettyJson(s.template.data).split("\n").join("\n  "));
    }
    if (s.template.opts !== undefined) {
      lines.push("  Options:");
      lines.push("  " + prettyJson(s.template.opts).split("\n").join("\n  "));
    }
  }

  if (s.nextJob) {
    lines.push("");
    lines.push("Next Job:");
    lines.push(`  ID:        ${s.nextJob.id}`);
    lines.push(`  State:     ${s.nextJob.state}`);
    lines.push(`  Timestamp: ${formatTs(s.nextJob.timestamp)}`);
    if (s.nextJob.delay) lines.push(`  Delay:     ${s.nextJob.delay}ms`);
  }

  if (s.recentJobs && s.recentJobs.length > 0) {
    lines.push("");
    lines.push("Recent Jobs:");
    const columns = ["ID", "State", "Timestamp", "Finished", "Failed Reason"];
    const align: ("l" | "r")[] = ["l", "l", "l", "l", "l"];

    const rows = s.recentJobs.map((j: RecentJobInfo) => [
      j.id,
      j.state,
      formatTs(j.timestamp),
      formatTs(j.finishedOn),
      j.failedReason ?? "-",
    ]);

    lines.push(table(columns, rows, align));
  }

  return lines.join("\n");
}

// ── Jobs retry ──────────────────────────────────────────────────────────

const MAX_DISPLAYED_ERRORS = 10;

interface JobsRetryInput {
  dryRun: boolean;
  queue: string;
  filter: { jobState: string; since?: string; name?: string };
  matched: number;
  retried: number;
  errors: RetryResult["errors"];
  sampleJobIds: string[];
  totalFailed: number;
  truncated: boolean;
}

export function formatJobsRetry(r: JobsRetryInput): string {
  const lines: string[] = [];

  const filterParts: string[] = [`state=${r.filter.jobState}`];
  if (r.filter.since) filterParts.push(`since=${r.filter.since}`);
  if (r.filter.name) filterParts.push(`name=${r.filter.name}`);

  if (r.dryRun) {
    lines.push(`DRY RUN: would retry ${r.matched} jobs in queue '${r.queue}'`);
  } else {
    lines.push(`Retry complete for queue '${r.queue}'`);
  }
  lines.push(`Filter:       ${filterParts.join(", ")}`);
  lines.push(`Total failed: ${r.totalFailed}`);
  lines.push(`Matched:      ${r.matched}`);
  if (!r.dryRun) {
    lines.push(`Retried:      ${r.retried}`);
    lines.push(`Errors:       ${r.errors.length}`);
  }
  if (r.truncated) {
    lines.push("");
    lines.push(
      "NOTE: more failed jobs exist than were fetched. Narrow with --since/--name or raise --page-size (max 10000).",
    );
  }

  if (r.sampleJobIds.length > 0) {
    lines.push("");
    lines.push("Sample matched IDs:");
    for (const id of r.sampleJobIds) {
      lines.push(`  ${id}`);
    }
  }

  if (!r.dryRun && r.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    const rows = r.errors.slice(0, MAX_DISPLAYED_ERRORS).map((e) => [e.jobId, e.error]);
    lines.push(table(["JOB ID", "ERROR"], rows));
    if (r.errors.length > MAX_DISPLAYED_ERRORS) {
      lines.push(
        `  ... and ${r.errors.length - MAX_DISPLAYED_ERRORS} more (see JSON output with --human-friendly off)`,
      );
    }
  }

  if (r.dryRun) {
    lines.push("");
    lines.push("Run without --dry-run to retry these jobs.");
  }

  return lines.join("\n");
}
