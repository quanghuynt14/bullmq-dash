import { describe, expect, it } from "bun:test";
import { StyledText, t, fg } from "@opentui/core";
import { concatStyledText } from "../src/ui/utils.js";

describe("concatStyledText", () => {
  describe("string inputs", () => {
    it("concatenates plain strings", () => {
      const result = concatStyledText("hello", " ", "world");
      expect(result).toBeInstanceOf(StyledText);
      expect(result.chunks.length).toBe(3);
    });

    it("handles single string", () => {
      const result = concatStyledText("hello");
      expect(result).toBeInstanceOf(StyledText);
      expect(result.chunks.length).toBe(1);
    });

    it("handles empty string", () => {
      const result = concatStyledText("");
      expect(result).toBeInstanceOf(StyledText);
      expect(result.chunks.length).toBe(1);
    });
  });

  describe("StyledText inputs", () => {
    it("concatenates StyledText objects", () => {
      const st1 = t`hello`;
      const st2 = t`world`;

      const result = concatStyledText(st1, st2);
      expect(result).toBeInstanceOf(StyledText);
      expect(result.chunks.length).toBe(2);
    });

    it("handles StyledText with styling", () => {
      const st = t`${fg("#ff0000")("red")} and ${fg("#00ff00")("green")}`;

      const result = concatStyledText(st);
      expect(result).toBeInstanceOf(StyledText);
      // The styled text should have multiple chunks
      expect(result.chunks.length).toBeGreaterThan(0);
    });
  });

  describe("mixed inputs", () => {
    it("concatenates strings and StyledText", () => {
      const st = t`styled`;

      const result = concatStyledText("prefix ", st, " suffix");
      expect(result).toBeInstanceOf(StyledText);
      expect(result.chunks.length).toBe(3);
    });

    it("handles complex mixed inputs", () => {
      const st1 = t`a`;
      const st2 = t`${fg("#ff0000")("b")}${fg("#00ff00")("c")}`;

      const result = concatStyledText("1", st1, "2", st2, "3");
      expect(result).toBeInstanceOf(StyledText);
      // Should have multiple chunks from all inputs
      expect(result.chunks.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("edge cases", () => {
    it("returns empty StyledText for no arguments", () => {
      const result = concatStyledText();
      expect(result).toBeInstanceOf(StyledText);
      expect(result.chunks.length).toBe(0);
    });

    it("preserves text content from StyledText", () => {
      const st = t`preserved`;
      const result = concatStyledText(st);

      expect(result.chunks[0].text).toBe("preserved");
    });

    it("converts plain strings to chunks with text property", () => {
      const result = concatStyledText("plain");
      expect(result.chunks[0].text).toBe("plain");
    });
  });
});
