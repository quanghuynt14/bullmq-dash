import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { extractSubcommand, getVersionText, parseNumericFlag, parseQueueNames } from "../src/config.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as {
  version: string;
};

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
      expect(parseQueueNames("queue1,queue2,queue3")).toEqual(["queue1", "queue2", "queue3"]);
    });

    it("trims whitespace from queue names", () => {
      expect(parseQueueNames("  queue1  ,  queue2  ")).toEqual(["queue1", "queue2"]);
    });

    it("filters out empty segments", () => {
      expect(parseQueueNames("queue1,,queue2")).toEqual(["queue1", "queue2"]);
      expect(parseQueueNames(",queue1,")).toEqual(["queue1"]);
    });

    it("filters out whitespace-only segments", () => {
      expect(parseQueueNames("queue1,   ,queue2")).toEqual(["queue1", "queue2"]);
    });

    it("handles mixed edge cases", () => {
      expect(parseQueueNames("  ,queue1, ,queue2,  ")).toEqual(["queue1", "queue2"]);
    });
  });
});

describe("getVersionText", () => {
  it("uses the version from package.json", () => {
    expect(getVersionText()).toBe(`bullmq-dash v${packageJson.version}`);
  });
});

describe("extractSubcommand", () => {
  it("returns empty arrays for empty input", () => {
    expect(extractSubcommand([])).toEqual({ positionals: [], flagArgv: [] });
  });

  it("separates positional args from flags", () => {
    expect(extractSubcommand(["jobs", "list", "--redis-host", "localhost"])).toEqual({
      positionals: ["jobs", "list"],
      flagArgv: ["--redis-host", "localhost"],
    });
  });

  it("stops collecting positionals when a flag is encountered", () => {
    expect(extractSubcommand(["queues", "--help"])).toEqual({
      positionals: ["queues"],
      flagArgv: ["--help"],
    });
  });

  it("treats everything after first flag as flags (unknown positionals passed to parseArgs for strict validation)", () => {
    expect(extractSubcommand(["jobs", "list", "--job-state", "failed", "extra"])).toEqual({
      positionals: ["jobs", "list"],
      flagArgv: ["--job-state", "failed", "extra"],
    });
  });

  it("handles only flags with no positionals", () => {
    expect(extractSubcommand(["--help"])).toEqual({
      positionals: [],
      flagArgv: ["--help"],
    });
  });

  it("handles only positionals with no flags", () => {
    expect(extractSubcommand(["queues", "list"])).toEqual({
      positionals: ["queues", "list"],
      flagArgv: [],
    });
  });

  it("handles short flags", () => {
    expect(extractSubcommand(["jobs", "-h"])).toEqual({
      positionals: ["jobs"],
      flagArgv: ["-h"],
    });
  });
});

describe("parseNumericFlag", () => {
  const mockExit = (() => {}) as never;

  it("returns undefined for undefined input", () => {
    expect(parseNumericFlag("page-size", undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseNumericFlag("page-size", "")).toBeUndefined();
  });

  it("parses a valid integer", () => {
    expect(parseNumericFlag("page-size", "42")).toBe(42);
  });

  it("parses zero", () => {
    expect(parseNumericFlag("redis-db", "0")).toBe(0);
  });

  it("parses large numbers", () => {
    expect(parseNumericFlag("page-size", "1000")).toBe(1000);
  });

  it("truncates float strings to integer without exiting", () => {
    // parseInt("3.14") returns 3, which is valid — only non-numeric strings fail
    expect(parseNumericFlag("page-size", "3.14")).toBe(3);
  });

  it("exits with code 2 for NaN input", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(mockExit);
    parseNumericFlag("page-size", "abc");
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it("exits with code 2 for purely non-numeric string", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(mockExit);
    parseNumericFlag("redis-port", "notanumber");
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });
});
