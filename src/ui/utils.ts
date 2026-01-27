import { StyledText } from "@opentui/core";

/**
 * Helper to concatenate multiple StyledText objects or strings
 * Uses unknown cast to work around internal chunk type not being exported
 */
export function concatStyledText(...texts: (StyledText | string)[]): StyledText {
  const allChunks: unknown[] = [];
  for (const text of texts) {
    if (typeof text === "string") {
      allChunks.push({ text, fg: null, bg: null, attrs: 0 });
    } else if (text instanceof StyledText) {
      allChunks.push(...text.chunks);
    }
  }
  // StyledText constructor accepts an array of chunks
  return new StyledText(allChunks as ConstructorParameters<typeof StyledText>[0]);
}
