// Leaf module: no other imports. Used by both src/config.ts and src/data/jobs.ts
// to avoid the config -> data/jobs -> data/queues -> config cycle.

const DURATION_PATTERN = /^(\d+)([smhd])$/;
const MS_PER_UNIT: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export const DEFAULT_RETRY_PAGE_SIZE = 1000;
export const MAX_RETRY_PAGE_SIZE = 10000;

/**
 * Parse a duration string like "30s", "5m", "1h", "24h", "7d" into milliseconds.
 * Returns null if the string is invalid. Callers translate null into a
 * structured CLI error.
 */
export function parseDuration(raw: string): number | null {
  const match = DURATION_PATTERN.exec(raw);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (!Number.isFinite(n) || n <= 0) return null;
  const unitMs = MS_PER_UNIT[unit];
  if (!unitMs) return null;
  return n * unitMs;
}
