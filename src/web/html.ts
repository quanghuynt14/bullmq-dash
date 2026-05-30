export interface WebIndexOptions {
  pollIntervalMs: number;
  prefix: string;
  readOnly: boolean;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function renderWebIndex(options: WebIndexOptions): string {
  const boot = scriptJson({
    pollIntervalMs: options.pollIntervalMs,
    prefix: options.prefix,
    readOnly: options.readOnly,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>bullmq-dash</title>
  <style>
    :root {
      color-scheme: dark;
      --base: #1e1e2e;
      --mantle: #181825;
      --surface0: #313244;
      --surface1: #45475a;
      --surface2: #585b70;
      --overlay0: #6c7086;
      --text: #cdd6f4;
      --muted: #a6adc8;
      --blue: #89b4fa;
      --green: #a6e3a1;
      --yellow: #f9e2af;
      --red: #f38ba8;
      --mauve: #cba6f7;
      --peach: #fab387;
      --border: rgba(205, 214, 244, 0.14);
      --shadow: rgba(0, 0, 0, 0.24);
      font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--base);
      color: var(--text);
      font-size: 13px;
      line-height: 1.5;
    }

    button,
    input,
    select {
      font: inherit;
    }

    button {
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--surface0);
      color: var(--text);
      cursor: pointer;
      padding: 6px 10px;
    }

    button:hover {
      border-color: var(--blue);
      color: var(--blue);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    button.danger {
      border-color: rgba(243, 139, 168, 0.42);
      color: var(--red);
    }

    input,
    select {
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--surface0);
      color: var(--text);
      padding: 5px 8px;
    }

    input {
      min-width: 0;
    }

    input::placeholder {
      color: var(--muted);
      opacity: 0.78;
    }

    [hidden] {
      display: none !important;
    }

    .shell {
      display: grid;
      grid-template-rows: auto auto auto 1fr;
      min-height: 100vh;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--mantle);
    }

    .brand {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }

    .brand h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .brand span,
    .status-line {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }

    .mode-badge {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--green);
      background: rgba(24, 24, 37, 0.38);
      font-size: 11px;
    }

    .mode-badge.read-only {
      color: var(--yellow);
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }

    .metric {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 12px;
      background: var(--surface0);
    }

    .metric-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
    }

    .metric-value {
      display: block;
      margin-top: 2px;
      font-size: 18px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    .focus-strip {
      display: grid;
      grid-template-columns: 1fr 1fr 1.2fr 1fr;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--base);
    }

    .focus-item {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 10px;
      background: rgba(49, 50, 68, 0.62);
    }

    .focus-value {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(280px, 0.9fr) minmax(360px, 1.2fr) minmax(340px, 1fr);
      gap: 12px;
      padding: 12px 16px 16px;
      min-height: 0;
    }

    .panel {
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: rgba(49, 50, 68, 0.74);
      overflow: hidden;
      box-shadow: 0 8px 28px var(--shadow);
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 42px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface0);
    }

    .panel-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--muted);
      white-space: nowrap;
    }

    .panel-body {
      max-height: calc(100vh - 232px);
      overflow: auto;
    }

    .panel-tools {
      position: sticky;
      top: 0;
      z-index: 2;
      display: grid;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--surface0);
    }

    .rank-list,
    .job-list {
      display: grid;
    }

    .queue-row,
    .job-row {
      display: grid;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      text-align: left;
      width: 100%;
      min-height: 68px;
    }

    .queue-row {
      grid-template-columns: 32px 1fr;
    }

    .job-row {
      grid-template-columns: 1fr auto;
    }

    .queue-row.active,
    .job-row.active {
      background: var(--surface1);
      border-color: rgba(137, 180, 250, 0.36);
    }

    .rank {
      color: var(--blue);
      font-variant-numeric: tabular-nums;
      font-weight: 700;
    }

    .name-line,
    .job-name-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }

    .queue-name,
    .job-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }

    .meta {
      color: var(--muted);
      font-size: 11px;
    }

    .bar {
      height: 6px;
      border-radius: 2px;
      background: var(--surface2);
      overflow: hidden;
      margin-top: 7px;
    }

    .bar-fill {
      display: block;
      height: 100%;
      min-width: 2px;
      background: var(--blue);
    }

    .counts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 7px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 22px;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--muted);
      background: rgba(24, 24, 37, 0.35);
      font-size: 11px;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .state-waiting,
    .state-wait,
    .pill.wait {
      color: var(--yellow);
    }

    .state-active,
    .pill.active {
      color: var(--blue);
    }

    .state-completed,
    .pill.completed {
      color: var(--green);
    }

    .state-failed,
    .pill.failed {
      color: var(--red);
    }

    .state-delayed,
    .pill.delayed {
      color: var(--mauve);
    }

    .pill.paused {
      color: var(--peach);
    }

    .jobs-tools {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .job-filter {
      min-width: 160px;
      flex: 1 1 160px;
    }

    .detail {
      padding: 12px;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 7px 12px;
      margin-bottom: 12px;
    }

    .key {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .value {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    pre {
      max-height: 270px;
      overflow: auto;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--mantle);
      color: var(--text);
      font-size: 12px;
      line-height: 1.45;
    }

    .pre-title {
      margin-top: 12px;
    }

    .detail-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 12px 0;
    }

    .notice,
    .empty {
      padding: 14px 12px;
      color: var(--muted);
    }

    .notice.error {
      color: var(--red);
    }

    .toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      max-width: min(420px, calc(100vw - 32px));
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--mantle);
      color: var(--text);
      padding: 10px 12px;
      box-shadow: 0 10px 30px var(--shadow);
      display: none;
    }

    .toast.visible {
      display: block;
    }

    @media (max-width: 1120px) {
      .workspace {
        grid-template-columns: 1fr 1fr;
      }

      .detail-panel {
        grid-column: 1 / -1;
      }

      .metrics {
        grid-template-columns: repeat(3, minmax(120px, 1fr));
      }

      .focus-strip {
        grid-template-columns: 1fr 1fr;
      }
    }

    @media (max-width: 760px) {
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .toolbar {
        width: 100%;
        justify-content: flex-start;
      }

      .metrics,
      .focus-strip,
      .workspace {
        grid-template-columns: 1fr;
      }

      .panel-body {
        max-height: none;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>bullmq-dash</h1>
        <span id="connectionLabel">prefix ${escapeHtml(options.prefix)}</span>
        <span class="mode-badge${options.readOnly ? " read-only" : ""}" id="modeLabel">${options.readOnly ? "read-only" : "live actions"}</span>
      </div>
      <div class="toolbar">
        <span class="status-line" id="lastUpdated">loading</span>
        <select id="sortBy" aria-label="Queue ranking">
          <option value="task-size">rank: task size</option>
          <option value="failed">rank: failed</option>
          <option value="waiting">rank: waiting</option>
          <option value="active">rank: active</option>
          <option value="completed">rank: completed</option>
          <option value="delayed">rank: delayed</option>
          <option value="name">rank: name</option>
        </select>
        <button id="refreshButton" type="button">refresh</button>
      </div>
    </header>

    <section class="metrics" id="metrics"></section>
    <section class="focus-strip" id="focusStrip"></section>

    <main class="workspace">
      <section class="panel">
        <div class="panel-head">
          <span class="panel-title">queues</span>
          <span class="meta" id="queueCount">0 queues</span>
        </div>
        <div class="panel-body">
          <div class="panel-tools">
            <input id="queueFilter" type="search" placeholder="filter queues" aria-label="Filter queues">
          </div>
          <div class="rank-list" id="queueList"></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <span class="panel-title" id="jobsTitle">jobs</span>
          <div class="jobs-tools">
            <input class="job-filter" id="jobFilter" type="search" placeholder="filter jobs" aria-label="Filter jobs">
            <select id="jobState" aria-label="Job state filter">
              <option value="failed">failed</option>
              <option value="all">all</option>
              <option value="wait">waiting</option>
              <option value="active">active</option>
              <option value="completed">completed</option>
              <option value="delayed">delayed</option>
            </select>
            <select id="pageSize" aria-label="Job page size">
              <option value="50">50</option>
              <option value="100" selected>100</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
            </select>
            <button id="retryBatchPreview" type="button">preview retry</button>
            ${options.readOnly ? "" : '<button id="retryBatch" class="danger" type="button">retry failed</button>'}
          </div>
        </div>
        <div class="panel-body">
          <div class="job-list" id="jobList"></div>
        </div>
      </section>

      <section class="panel detail-panel">
        <div class="panel-head">
          <span class="panel-title">detail</span>
          <span class="meta" id="detailState">idle</span>
        </div>
        <div class="panel-body detail" id="detail"></div>
      </section>
    </main>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    window.__BULLMQ_DASH__ = ${boot};
  </script>
  <script>
${clientScript()}
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clientScript(): string {
  return String.raw`
const boot = window.__BULLMQ_DASH__;
const state = {
  queues: [],
  metrics: null,
  selectedQueue: null,
  jobs: [],
  selectedJob: null,
  jobDetail: null,
  jobState: "failed",
  pageSize: 100,
  queueFilter: "",
  jobFilter: "",
  jobsTotal: 0,
  sortBy: "task-size",
  loading: false,
};

const el = {
  metrics: document.getElementById("metrics"),
  focusStrip: document.getElementById("focusStrip"),
  queueList: document.getElementById("queueList"),
  jobList: document.getElementById("jobList"),
  detail: document.getElementById("detail"),
  sortBy: document.getElementById("sortBy"),
  jobState: document.getElementById("jobState"),
  pageSize: document.getElementById("pageSize"),
  queueFilter: document.getElementById("queueFilter"),
  jobFilter: document.getElementById("jobFilter"),
  jobsTitle: document.getElementById("jobsTitle"),
  detailState: document.getElementById("detailState"),
  queueCount: document.getElementById("queueCount"),
  lastUpdated: document.getElementById("lastUpdated"),
  refreshButton: document.getElementById("refreshButton"),
  retryBatchPreview: document.getElementById("retryBatchPreview"),
  retryBatch: document.getElementById("retryBatch"),
  toast: document.getElementById("toast"),
};

function matchesFilter(value, filter) {
  return String(value || "").toLowerCase().includes(String(filter || "").trim().toLowerCase());
}

function visibleQueues() {
  if (!state.queueFilter) return state.queues;
  return state.queues.filter((queue) => (
    matchesFilter(queue.name, state.queueFilter) ||
    matchesFilter(queue.rankReason, state.queueFilter)
  ));
}

function visibleJobs() {
  if (!state.jobFilter) return state.jobs;
  return state.jobs.filter((job) => (
    matchesFilter(job.id, state.jobFilter) ||
    matchesFilter(job.name, state.jobFilter) ||
    matchesFilter(job.state, state.jobFilter)
  ));
}

function selectedQueue() {
  return state.queues.find((queue) => queue.name === state.selectedQueue) || null;
}

function fmt(value) {
  const number = Number(value || 0);
  if (number >= 1000000) return (number / 1000000).toFixed(1) + "M";
  if (number >= 1000) return (number / 1000).toFixed(1) + "K";
  return String(number);
}

function ts(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusClass(status) {
  const normalized = String(status || "unknown").toLowerCase();
  if (normalized === "waiting" || normalized === "prioritized") return "state-waiting";
  if (["active", "completed", "failed", "delayed"].includes(normalized)) return "state-" + normalized;
  return "";
}

function setText(node, value) {
  node.textContent = value == null ? "" : String(value);
}

function toast(message, danger = false) {
  el.toast.textContent = message;
  el.toast.style.borderColor = danger ? "rgba(243, 139, 168, 0.62)" : "rgba(137, 180, 250, 0.5)";
  el.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("visible"), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "accept": "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : "Request failed");
  }
  return data;
}

function renderMetrics() {
  const counts = state.metrics ? state.metrics.jobCounts : {};
  const failedQueues = state.queues.filter((queue) => queue.counts.failed > 0).length;
  const items = [
    ["queues", state.metrics ? state.metrics.queueCount : 0, ""],
    ["failed queues", failedQueues, failedQueues > 0 ? "state-failed" : ""],
    ["failed jobs", counts.failed, "state-failed"],
    ["waiting", counts.wait, "state-waiting"],
    ["active", counts.active, "state-active"],
    ["delayed", counts.delayed, "state-delayed"],
  ];
  el.metrics.replaceChildren(...items.map(([label, value, cls]) => {
    const card = document.createElement("div");
    card.className = "metric";
    const small = document.createElement("span");
    small.className = "metric-label";
    setText(small, label);
    const strong = document.createElement("span");
    strong.className = "metric-value " + cls;
    setText(strong, fmt(value));
    card.append(small, strong);
    return card;
  }));
}

function renderFocusStrip() {
  const counts = state.metrics ? state.metrics.jobCounts : {};
  const failedQueues = state.queues.filter((queue) => queue.counts.failed > 0);
  const topQueue = state.queues[0] || null;
  const currentQueue = selectedQueue();
  const backlog = (counts.wait || 0) + (counts.delayed || 0);
  const items = [
    [
      "attention",
      failedQueues.length > 0 ? failedQueues.length + " queues / " + fmt(counts.failed) + " failed" : "clear",
      failedQueues.length > 0 ? "state-failed" : "state-completed",
    ],
    ["backlog", fmt(backlog) + " waiting+delayed", backlog > 0 ? "state-waiting" : ""],
    ["top ranked", topQueue ? topQueue.name + " · " + topQueue.rankReason : "-", topQueue && topQueue.counts.failed > 0 ? "state-failed" : ""],
    ["selected", currentQueue ? currentQueue.name + " · " + currentQueue.rankReason : "-", currentQueue && currentQueue.counts.failed > 0 ? "state-failed" : ""],
  ];
  el.focusStrip.replaceChildren(...items.map(([label, value, cls]) => {
    const card = document.createElement("div");
    card.className = "focus-item";
    const small = document.createElement("span");
    small.className = "metric-label";
    setText(small, label);
    const strong = document.createElement("span");
    strong.className = "focus-value " + cls;
    setText(strong, value);
    card.append(small, strong);
    return card;
  }));
}

function renderQueues() {
  const queues = visibleQueues();
  setText(
    el.queueCount,
    queues.length === state.queues.length
      ? state.queues.length + " queues"
      : queues.length + " of " + state.queues.length + " queues",
  );
  if (queues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    setText(empty, state.queues.length === 0 ? "No queues observed" : "No queues match");
    el.queueList.replaceChildren(empty);
    return;
  }

  const maxScore = Math.max(1, ...queues.map((queue) => queue.rankScore || 0));
  el.queueList.replaceChildren(...queues.map((queue) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "queue-row" + (state.selectedQueue === queue.name ? " active" : "");
    row.addEventListener("click", () => selectQueue(queue.name));

    const rank = document.createElement("div");
    rank.className = "rank";
    setText(rank, "#" + queue.rank);

    const body = document.createElement("div");
    const line = document.createElement("div");
    line.className = "name-line";
    const name = document.createElement("span");
    name.className = "queue-name";
    setText(name, queue.name);
    const score = document.createElement("span");
    score.className = "meta";
    setText(score, "score " + fmt(queue.rankScore));
    line.append(name, score);

    const meta = document.createElement("div");
    meta.className = "meta";
    setText(meta, queue.rankReason);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = Math.max(2, Math.round(((queue.rankScore || 0) / maxScore) * 100)) + "%";
    bar.append(fill);

    const counts = document.createElement("div");
    counts.className = "counts";
    counts.append(
      pill("wait", queue.counts.wait),
      pill("active", queue.counts.active),
      pill("completed", queue.counts.completed),
      pill("failed", queue.counts.failed),
      pill("delayed", queue.counts.delayed),
    );
    if (queue.isPaused) counts.append(pill("paused", 1));

    body.append(line, meta, bar, counts);
    row.append(rank, body);
    return row;
  }));
}

function pill(label, value) {
  const span = document.createElement("span");
  span.className = "pill " + label;
  setText(span, label + " " + fmt(value));
  return span;
}

function renderJobs() {
  const jobs = visibleJobs();
  const suffix = state.jobsTotal > state.jobs.length ? " of " + fmt(state.jobsTotal) : "";
  setText(
    el.jobsTitle,
    state.selectedQueue
      ? "jobs / " + state.selectedQueue + " · " + jobs.length + suffix
      : "jobs",
  );
  el.retryBatchPreview.disabled = !state.selectedQueue || state.jobState !== "failed";
  if (el.retryBatch) {
    el.retryBatch.disabled = !state.selectedQueue || state.jobState !== "failed" || boot.readOnly;
    el.retryBatch.hidden = boot.readOnly;
  }
  if (!state.selectedQueue) {
    const empty = document.createElement("div");
    empty.className = "empty";
    setText(empty, "No queue selected");
    el.jobList.replaceChildren(empty);
    return;
  }
  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    setText(empty, state.jobs.length === 0 ? "No jobs" : "No jobs match");
    el.jobList.replaceChildren(empty);
    return;
  }
  el.jobList.replaceChildren(...jobs.map((job) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "job-row" + (state.selectedJob && state.selectedJob.id === job.id ? " active" : "");
    row.addEventListener("click", () => selectJob(job));

    const main = document.createElement("div");
    const line = document.createElement("div");
    line.className = "job-name-line";
    const name = document.createElement("span");
    name.className = "job-name";
    setText(name, job.name || "(unnamed)");
    const id = document.createElement("span");
    id.className = "meta";
    setText(id, "#" + job.id);
    line.append(name, id);
    const when = document.createElement("div");
    when.className = "meta";
    setText(when, ts(job.timestamp));
    main.append(line, when);

    const status = document.createElement("span");
    status.className = "pill " + statusClass(job.state);
    setText(status, job.state);

    row.append(main, status);
    return row;
  }));
}

function hasDetailValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function detailText(value) {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("\\n\\n");
  }
  return JSON.stringify(value, null, 2);
}

function appendDetailBlock(parent, label, value) {
  if (!hasDetailValue(value)) return;
  const title = document.createElement("div");
  title.className = "key pre-title";
  setText(title, label);
  const pre = document.createElement("pre");
  setText(pre, detailText(value));
  parent.append(title, pre);
}

function renderDetail() {
  el.detail.replaceChildren();
  if (!state.jobDetail) {
    setText(el.detailState, "idle");
    const empty = document.createElement("div");
    empty.className = "empty";
    setText(empty, "No job selected");
    el.detail.append(empty);
    return;
  }

  const job = state.jobDetail.job;
  setText(el.detailState, job.state);
  const grid = document.createElement("div");
  grid.className = "detail-grid";
  [
    ["id", job.id],
    ["name", job.name],
    ["state", job.state],
    ["attempts", job.attemptsMade],
    ["created", ts(job.timestamp)],
    ["processed", ts(job.processedOn)],
    ["finished", ts(job.finishedOn)],
    ["failed", job.failedReason || "-"],
  ].forEach(([key, value]) => {
    const k = document.createElement("div");
    k.className = "key";
    setText(k, key);
    const v = document.createElement("div");
    v.className = "value " + (key === "state" ? statusClass(value) : "");
    setText(v, value);
    grid.append(k, v);
  });

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const copyId = document.createElement("button");
  copyId.type = "button";
  setText(copyId, "copy id");
  copyId.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(job.id);
      toast("Copied job id");
    } catch {
      toast("Clipboard unavailable", true);
    }
  });
  const preview = document.createElement("button");
  preview.type = "button";
  setText(preview, "preview retry");
  preview.disabled = job.state !== "failed";
  preview.addEventListener("click", () => retryJob(job.id, true));
  actions.append(copyId, preview);
  if (!boot.readOnly) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "danger";
    setText(retry, "retry");
    retry.disabled = job.state !== "failed";
    retry.addEventListener("click", () => retryJob(job.id, false));
    actions.append(retry);
  }

  el.detail.append(grid, actions);
  appendDetailBlock(el.detail, "stacktrace", job.stacktrace);
  appendDetailBlock(el.detail, "data", job.data);
  appendDetailBlock(el.detail, "opts", job.opts);
  appendDetailBlock(el.detail, "progress", job.progress);
  appendDetailBlock(el.detail, "returnvalue", job.returnvalue);
}

async function refreshOverview() {
  if (state.loading) return;
  state.loading = true;
  el.refreshButton.disabled = true;
  try {
    const overview = await api("/api/overview?sortBy=" + encodeURIComponent(state.sortBy));
    state.queues = overview.queues;
    state.metrics = overview.metrics;
    const stillExists = state.queues.some((queue) => queue.name === state.selectedQueue);
    if (!stillExists) {
      state.selectedQueue = state.queues[0] ? state.queues[0].name : null;
      state.jobs = [];
      state.jobsTotal = 0;
      state.selectedJob = null;
      state.jobDetail = null;
    }
    renderMetrics();
    renderFocusStrip();
    renderQueues();
    renderJobs();
    renderDetail();
    setText(el.lastUpdated, new Date(overview.timestamp).toLocaleTimeString());
    if (state.selectedQueue) await refreshJobs();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loading = false;
    el.refreshButton.disabled = false;
  }
}

async function refreshJobs() {
  if (!state.selectedQueue) return;
  const params = new URLSearchParams();
  if (state.jobState !== "all") params.set("state", state.jobState);
  params.set("pageSize", String(state.pageSize));
  try {
    const result = await api("/api/queues/" + encodeURIComponent(state.selectedQueue) + "/jobs?" + params.toString());
    const selectedJobId = state.selectedJob ? state.selectedJob.id : null;
    state.jobs = result.jobs;
    state.jobsTotal = result.total;
    state.selectedJob = state.jobs.find((job) => job.id === selectedJobId) || state.jobs[0] || null;
    if (!state.selectedJob || !state.jobDetail || state.jobDetail.job.id !== state.selectedJob.id) {
      state.jobDetail = null;
    }
    renderJobs();
    renderDetail();
    if (state.selectedJob) await selectJob(state.selectedJob);
  } catch (error) {
    state.jobs = [];
    state.jobsTotal = 0;
    state.selectedJob = null;
    state.jobDetail = null;
    renderJobs();
    renderDetail();
    toast(error.message, true);
  }
}

async function selectQueue(name) {
  state.selectedQueue = name;
  state.selectedJob = null;
  state.jobDetail = null;
  renderQueues();
  renderJobs();
  renderDetail();
  await refreshJobs();
}

async function selectJob(job) {
  state.selectedJob = job;
  state.jobDetail = null;
  renderJobs();
  renderDetail();
  try {
    state.jobDetail = await api("/api/queues/" + encodeURIComponent(state.selectedQueue) + "/jobs/" + encodeURIComponent(job.id));
    renderDetail();
  } catch (error) {
    toast(error.message, true);
  }
}

async function retryJob(jobId, dryRun) {
  if (!state.selectedQueue || !jobId) return;
  if (!dryRun && boot.readOnly) {
    toast("Read-only mode blocks live retry", true);
    return;
  }
  try {
    const result = await api(
      "/api/queues/" + encodeURIComponent(state.selectedQueue) + "/jobs/" + encodeURIComponent(jobId) + "/retry",
      {
        method: "POST",
        body: JSON.stringify({ dryRun, confirm: !dryRun }),
      },
    );
    toast(dryRun ? "Matched " + result.matched + " failed job" : "Retried " + result.retried + " failed job");
    if (!dryRun) await refreshOverview();
  } catch (error) {
    toast(error.message, true);
  }
}

async function previewBatchRetry() {
  if (!state.selectedQueue) return;
  try {
    const result = await api("/api/queues/" + encodeURIComponent(state.selectedQueue) + "/retry-failed", {
      method: "POST",
      body: JSON.stringify({ dryRun: true, pageSize: 1000 }),
    });
    toast("Matched " + result.matched + " failed jobs; sample " + (result.sampleJobIds.join(", ") || "-"));
  } catch (error) {
    toast(error.message, true);
  }
}

async function retryBatchFailed() {
  if (!state.selectedQueue) return;
  if (boot.readOnly) {
    toast("Read-only mode blocks live retry", true);
    return;
  }
  const confirmed = window.confirm("Retry up to 1000 failed jobs in " + state.selectedQueue + "?");
  if (!confirmed) return;
  try {
    const result = await api("/api/queues/" + encodeURIComponent(state.selectedQueue) + "/retry-failed", {
      method: "POST",
      body: JSON.stringify({ dryRun: false, confirm: true, pageSize: 1000 }),
    });
    toast("Retried " + result.retried + " failed jobs");
    await refreshOverview();
  } catch (error) {
    toast(error.message, true);
  }
}

el.refreshButton.addEventListener("click", refreshOverview);
el.sortBy.addEventListener("change", () => {
  state.sortBy = el.sortBy.value;
  refreshOverview();
});
el.jobState.addEventListener("change", () => {
  state.jobState = el.jobState.value;
  refreshJobs();
});
el.pageSize.addEventListener("change", () => {
  state.pageSize = Number(el.pageSize.value);
  refreshJobs();
});
el.queueFilter.addEventListener("input", () => {
  state.queueFilter = el.queueFilter.value;
  renderQueues();
});
el.jobFilter.addEventListener("input", () => {
  state.jobFilter = el.jobFilter.value;
  renderJobs();
});
el.retryBatchPreview.addEventListener("click", previewBatchRetry);
if (el.retryBatch) el.retryBatch.addEventListener("click", retryBatchFailed);

refreshOverview();
setInterval(refreshOverview, Math.max(boot.pollIntervalMs || 3000, 1500));
`;
}
