import { describe, expect, it } from "bun:test";
import { clampPaletteIndex, filterPaletteActions, type PaletteAction } from "./command-palette.js";

const ACTIONS: PaletteAction[] = [
  { id: "refresh", title: "Refresh data now", hint: "r" },
  { id: "sort-failed", title: "Sort queues by failed jobs", hint: "s" },
  { id: "status-failed", title: "Show failed jobs", hint: "5" },
  { id: "quit", title: "Quit bullmq-dash", hint: "q" },
];

describe("filterPaletteActions", () => {
  it("returns all actions for an empty or whitespace query", () => {
    expect(filterPaletteActions(ACTIONS, "")).toEqual(ACTIONS);
    expect(filterPaletteActions(ACTIONS, "   ")).toEqual(ACTIONS);
  });

  it("matches case-insensitive substrings on the title", () => {
    const failed = filterPaletteActions(ACTIONS, "FAILED");
    expect(failed.map((a) => a.id)).toEqual(["sort-failed", "status-failed"]);
    expect(filterPaletteActions(ACTIONS, "quit").map((a) => a.id)).toEqual(["quit"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterPaletteActions(ACTIONS, "zzz")).toEqual([]);
  });
});

describe("clampPaletteIndex", () => {
  it("clamps into the list bounds", () => {
    expect(clampPaletteIndex(0, 4)).toBe(0);
    expect(clampPaletteIndex(3, 4)).toBe(3);
    expect(clampPaletteIndex(9, 4)).toBe(3);
    expect(clampPaletteIndex(-2, 4)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(clampPaletteIndex(5, 0)).toBe(0);
  });
});
