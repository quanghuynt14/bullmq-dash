import { describe, expect, it } from "bun:test";
import { formatNumber } from "../src/ui/global-metrics.js";

describe("formatNumber", () => {
  describe("small numbers (< 1000)", () => {
    it("returns '0' for zero", () => {
      expect(formatNumber(0)).toBe("0");
    });

    it("returns the number as string for small values", () => {
      expect(formatNumber(1)).toBe("1");
      expect(formatNumber(42)).toBe("42");
      expect(formatNumber(100)).toBe("100");
      expect(formatNumber(999)).toBe("999");
    });
  });

  describe("thousands (1K - 999K)", () => {
    it("formats 1000 as '1.0K'", () => {
      expect(formatNumber(1000)).toBe("1.0K");
    });

    it("formats numbers with decimal precision", () => {
      expect(formatNumber(1500)).toBe("1.5K");
      expect(formatNumber(2750)).toBe("2.8K"); // Rounds to 2.8
      expect(formatNumber(9999)).toBe("10.0K");
    });

    it("formats larger thousands", () => {
      expect(formatNumber(10000)).toBe("10.0K");
      expect(formatNumber(50000)).toBe("50.0K");
      expect(formatNumber(100000)).toBe("100.0K");
      expect(formatNumber(999999)).toBe("1000.0K"); // Just under 1M
    });
  });

  describe("millions (>= 1M)", () => {
    it("formats 1000000 as '1.0M'", () => {
      expect(formatNumber(1000000)).toBe("1.0M");
    });

    it("formats millions with decimal precision", () => {
      expect(formatNumber(1500000)).toBe("1.5M");
      expect(formatNumber(2750000)).toBe("2.8M");
      expect(formatNumber(10000000)).toBe("10.0M");
    });

    it("formats large millions", () => {
      expect(formatNumber(100000000)).toBe("100.0M");
      expect(formatNumber(999000000)).toBe("999.0M");
    });
  });

  describe("boundary values", () => {
    it("handles the transition from raw number to K", () => {
      expect(formatNumber(999)).toBe("999"); // Still raw
      expect(formatNumber(1000)).toBe("1.0K"); // Now K
    });

    it("handles the transition from K to M", () => {
      expect(formatNumber(999999)).toBe("1000.0K"); // Still K
      expect(formatNumber(1000000)).toBe("1.0M"); // Now M
    });
  });
});
