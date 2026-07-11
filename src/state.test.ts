import { beforeEach, describe, expect, it } from "bun:test";
import type { QueueStats } from "./data/queues.js";
import { filterQueues, stateManager } from "./state.js";

function queue(name: string, total: number = 0): QueueStats {
  return {
    name,
    counts: { wait: 0, active: 0, completed: 0, failed: 0, delayed: 0, schedulers: 0 },
    isPaused: false,
    total,
  };
}

const EMAIL = queue("email", 10);
const PAYMENTS = queue("payments", 20);
const NOTIFICATIONS = queue("notifications", 5);

beforeEach(() => {
  // stateManager is a process-wide singleton; reset everything these tests touch.
  stateManager.setState({
    queues: [],
    allQueues: [],
    queueFilter: "",
    queueSearchActive: false,
    selectedQueueIndex: 0,
    selectedJobIndex: 0,
    jobsPage: 1,
    queueSortBy: "name",
    queueSortOrder: "asc",
    focusedPane: "queues",
  });
});

describe("filterQueues", () => {
  it("matches case-insensitive substrings", () => {
    const queues = [EMAIL, PAYMENTS, NOTIFICATIONS];
    expect(filterQueues(queues, "PAY").map((q) => q.name)).toEqual(["payments"]);
    expect(filterQueues(queues, "ti").map((q) => q.name)).toEqual(["notifications"]);
  });

  it("returns all queues for an empty or whitespace filter", () => {
    const queues = [EMAIL, PAYMENTS];
    expect(filterQueues(queues, "")).toEqual(queues);
    expect(filterQueues(queues, "  ")).toEqual(queues);
  });
});

describe("applyQueues", () => {
  it("derives the visible list from the active filter", () => {
    stateManager.setQueueFilter("mail");
    stateManager.applyQueues([EMAIL, PAYMENTS, NOTIFICATIONS]);

    const state = stateManager.getState();
    expect(state.allQueues.map((q) => q.name)).toEqual(["email", "payments", "notifications"]);
    expect(state.queues.map((q) => q.name)).toEqual(["email"]);
  });

  it("preserves the selected queue by name across observations", () => {
    stateManager.applyQueues([EMAIL, PAYMENTS, NOTIFICATIONS]);
    stateManager.setState({ selectedQueueIndex: 1 }); // payments

    stateManager.applyQueues([PAYMENTS, EMAIL, NOTIFICATIONS]);
    expect(stateManager.getState().selectedQueueIndex).toBe(0);
    expect(stateManager.getSelectedQueue()?.name).toBe("payments");
  });

  it("clamps the selection when the selected queue disappears", () => {
    stateManager.applyQueues([EMAIL, PAYMENTS, NOTIFICATIONS]);
    stateManager.setState({ selectedQueueIndex: 2 }); // notifications

    stateManager.applyQueues([EMAIL, PAYMENTS]);
    expect(stateManager.getState().selectedQueueIndex).toBe(1);
  });
});

describe("setQueueFilter", () => {
  beforeEach(() => {
    stateManager.applyQueues([EMAIL, PAYMENTS, NOTIFICATIONS]);
  });

  it("narrows the visible list without touching allQueues", () => {
    stateManager.setQueueFilter("not");
    const state = stateManager.getState();
    expect(state.queues.map((q) => q.name)).toEqual(["notifications"]);
    expect(state.allQueues.length).toBe(3);
    expect(state.queueFilter).toBe("not");
  });

  it("keeps the selected queue and job position when it still matches", () => {
    stateManager.setState({ selectedQueueIndex: 1, selectedJobIndex: 4, jobsPage: 3 });

    stateManager.setQueueFilter("pay");
    const state = stateManager.getState();
    expect(stateManager.getSelectedQueue()?.name).toBe("payments");
    expect(state.selectedJobIndex).toBe(4);
    expect(state.jobsPage).toBe(3);
  });

  it("resets selection and job position when the selected queue is filtered out", () => {
    stateManager.setState({ selectedQueueIndex: 1, selectedJobIndex: 4, jobsPage: 3 });

    stateManager.setQueueFilter("email");
    const state = stateManager.getState();
    expect(state.selectedQueueIndex).toBe(0);
    expect(stateManager.getSelectedQueue()?.name).toBe("email");
    expect(state.selectedJobIndex).toBe(0);
    expect(state.jobsPage).toBe(1);
  });

  it("restores the full list when cleared", () => {
    stateManager.setQueueFilter("zzz");
    expect(stateManager.getState().queues.length).toBe(0);
    stateManager.setQueueFilter("");
    expect(stateManager.getState().queues.length).toBe(3);
  });
});

describe("queue search mode", () => {
  beforeEach(() => {
    stateManager.applyQueues([EMAIL, PAYMENTS, NOTIFICATIONS]);
  });

  it("opens focused on the queues pane", () => {
    stateManager.setState({ focusedPane: "jobs" });
    stateManager.openQueueSearch();
    const state = stateManager.getState();
    expect(state.queueSearchActive).toBe(true);
    expect(state.focusedPane).toBe("queues");
  });

  it("builds the filter with append and backspace", () => {
    stateManager.openQueueSearch();
    stateManager.appendQueueFilter("p");
    stateManager.appendQueueFilter("a");
    stateManager.appendQueueFilter("x");
    expect(stateManager.getState().queues.length).toBe(0);
    stateManager.backspaceQueueFilter();
    expect(stateManager.getState().queueFilter).toBe("pa");
    expect(stateManager.getState().queues.map((q) => q.name)).toEqual(["payments"]);
  });

  it("keeps the filter on close(true) and clears it on close(false)", () => {
    stateManager.openQueueSearch();
    stateManager.appendQueueFilter("e");

    stateManager.closeQueueSearch(true);
    let state = stateManager.getState();
    expect(state.queueSearchActive).toBe(false);
    expect(state.queueFilter).toBe("e");

    stateManager.openQueueSearch();
    stateManager.closeQueueSearch(false);
    state = stateManager.getState();
    expect(state.queueFilter).toBe("");
    expect(state.queues.length).toBe(3);
  });
});

describe("cycleQueueSort with a filter active", () => {
  it("sorts allQueues and reapplies the filter", () => {
    stateManager.applyQueues([EMAIL, NOTIFICATIONS, PAYMENTS]);
    stateManager.setQueueFilter("ent");

    // name/asc -> task-size/desc
    stateManager.cycleQueueSort();
    const state = stateManager.getState();
    expect(state.queueSortBy).toBe("task-size");
    expect(state.allQueues.map((q) => q.name)).toEqual(["payments", "email", "notifications"]);
    expect(state.queues.map((q) => q.name)).toEqual(["payments"]);
    expect(state.queueFilter).toBe("ent");
  });
});
