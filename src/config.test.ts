import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extractSubcommand,
  getVersionText,
  parseCliArgs,
  parseNumericFlag,
  parseQueueNames,
} from "./config.js";

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

  it("exits with code 2 when value is below min", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(mockExit);
    parseNumericFlag("page-size", "0", { min: 1 });
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it("exits with code 2 for negative values when min is 1", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(mockExit);
    parseNumericFlag("page-size", "-5", { min: 1 });
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it("allows zero when no min is specified", () => {
    expect(parseNumericFlag("redis-db", "0")).toBe(0);
  });

  it("allows value equal to min", () => {
    expect(parseNumericFlag("page-size", "1", { min: 1 })).toBe(1);
  });
});

describe("parseCliArgs", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("exits with code 2 for --page-size -1 (space-separated negative value)", () => {
    // BUG-001 regression: parseArgs throws ERR_PARSE_ARGS_INVALID_OPTION_VALUE
    // when a negative number is passed space-separated, which was previously
    // uncaught and caused a raw TypeError stack trace (exit 1) instead of a
    // structured JSON error (exit 2).
    process.argv = ["bun", "index.ts", "jobs", "list", "email", "--redis-host", "localhost", "--page-size", "-1"];

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 for --redis-port -1 (space-separated negative value)", () => {
    process.argv = ["bun", "index.ts", "--tui", "--redis-host", "localhost", "--redis-port", "-1"];

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 for unknown options", () => {
    process.argv = ["bun", "index.ts", "queues", "list", "--redis-host", "localhost", "--bogus"];

    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe("parseCliArgs — jobs retry", () => {
  let originalArgv: string[];
  // Safety net: any unintended `process.exit` inside parseCliArgs throws so the
  // test fails loudly. Without this, bun:test silently terminates on exit() and
  // reports nothing — which is how the broken --dry-run gates shipped originally.
  let exitSafetySpy: ReturnType<typeof spyOn>;
  let stderrSafetySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    exitSafetySpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    });
    stderrSafetySpy = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSafetySpy.mockRestore();
    stderrSafetySpy.mockRestore();
  });

  it("parses a basic dry-run retry", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "retry",
      "payments",
      "--redis-host",
      "localhost",
      "--job-state",
      "failed",
      "--dry-run",
    ];
    const args = parseCliArgs();
    expect(args.subcommand).toEqual({
      kind: "jobs-retry",
      queue: "payments",
      jobState: "failed",
      since: undefined,
      name: undefined,
      pageSize: undefined,
      dryRun: true,
    });
  });

  it("parses --since and --name filters", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "retry",
      "payments",
      "--redis-host",
      "localhost",
      "--job-state",
      "failed",
      "--since",
      "1h",
      "--name",
      "welcome-email",
    ];
    const args = parseCliArgs();
    expect(args.subcommand).toEqual({
      kind: "jobs-retry",
      queue: "payments",
      jobState: "failed",
      since: "1h",
      name: "welcome-email",
      pageSize: undefined,
      dryRun: false,
    });
  });

  it("exits with code 2 when --job-state is missing", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "retry",
      "payments",
      "--redis-host",
      "localhost",
    ];
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 when --job-state is not 'failed'", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "retry",
      "payments",
      "--redis-host",
      "localhost",
      "--job-state",
      "completed",
    ];
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 when queue positional is missing", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "retry",
      "--redis-host",
      "localhost",
      "--job-state",
      "failed",
    ];
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 when --dry-run is used outside 'jobs retry'", () => {
    process.argv = [
      "bun",
      "index.ts",
      "queues",
      "list",
      "--redis-host",
      "localhost",
      "--dry-run",
    ];
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 when --since is used outside 'jobs retry'", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "list",
      "email",
      "--redis-host",
      "localhost",
      "--since",
      "1h",
    ];
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("exits with code 2 when --page-size exceeds 10000", () => {
    process.argv = [
      "bun",
      "index.ts",
      "jobs",
      "retry",
      "payments",
      "--redis-host",
      "localhost",
      "--job-state",
      "failed",
      "--page-size",
      "100000",
    ];
    const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseCliArgs()).toThrow("process.exit(2)");
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
