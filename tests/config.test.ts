import { describe, expect, it } from "bun:test";
import { parseQueueNames } from "../src/config.js";

describe("parseQueueNames", () => {
  describe("returns undefined", () => {
    it("when value is undefined", () => {
      expect(parseQueueNames(undefined)).toBeUndefined();
    });

    it("when value is empty string", () => {
      expect(parseQueueNames("")).toBeUndefined();
    });

    it("when value is only whitespace", () => {
      expect(parseQueueNames("   ")).toBeUndefined();
      expect(parseQueueNames("\t\n")).toBeUndefined();
    });
  });

  describe("parses queue names correctly", () => {
    it("handles single queue name", () => {
      expect(parseQueueNames("queue1")).toEqual(["queue1"]);
    });

    it("handles multiple queue names", () => {
      expect(parseQueueNames("queue1,queue2,queue3")).toEqual([
        "queue1",
        "queue2",
        "queue3",
      ]);
    });

    it("trims whitespace from queue names", () => {
      expect(parseQueueNames("  queue1  ,  queue2  ")).toEqual([
        "queue1",
        "queue2",
      ]);
    });

    it("filters out empty segments", () => {
      expect(parseQueueNames("queue1,,queue2")).toEqual(["queue1", "queue2"]);
      expect(parseQueueNames(",queue1,")).toEqual(["queue1"]);
    });

    it("filters out whitespace-only segments", () => {
      expect(parseQueueNames("queue1,   ,queue2")).toEqual([
        "queue1",
        "queue2",
      ]);
    });

    it("handles mixed edge cases", () => {
      expect(parseQueueNames("  ,queue1, ,queue2,  ")).toEqual([
        "queue1",
        "queue2",
      ]);
    });
  });
});
