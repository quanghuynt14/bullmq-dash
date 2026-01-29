import { describe, expect, it } from "bun:test";
import { getStatusFromKey } from "../src/ui/status-filter.js";

describe("getStatusFromKey", () => {
  describe("valid keys", () => {
    it("returns 'latest' for key '1'", () => {
      expect(getStatusFromKey("1")).toBe("latest");
    });

    it("returns 'wait' for key '2'", () => {
      expect(getStatusFromKey("2")).toBe("wait");
    });

    it("returns 'active' for key '3'", () => {
      expect(getStatusFromKey("3")).toBe("active");
    });

    it("returns 'completed' for key '4'", () => {
      expect(getStatusFromKey("4")).toBe("completed");
    });

    it("returns 'failed' for key '5'", () => {
      expect(getStatusFromKey("5")).toBe("failed");
    });

    it("returns 'delayed' for key '6'", () => {
      expect(getStatusFromKey("6")).toBe("delayed");
    });
  });

  describe("invalid keys", () => {
    it("returns null for key '0'", () => {
      expect(getStatusFromKey("0")).toBeNull();
    });

    it("returns null for key '99'", () => {
      expect(getStatusFromKey("99")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(getStatusFromKey("")).toBeNull();
    });

    it("returns null for non-numeric keys", () => {
      expect(getStatusFromKey("a")).toBeNull();
      expect(getStatusFromKey("latest")).toBeNull();
      expect(getStatusFromKey(" ")).toBeNull();
    });

    it("returns null for multi-character strings", () => {
      expect(getStatusFromKey("12")).toBeNull();
      expect(getStatusFromKey("1 ")).toBeNull();
    });
  });
});
