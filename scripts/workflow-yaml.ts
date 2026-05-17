// Shared YAML-command parsing for workflow-policy and lockfile-policy. Both
// scripts walk the same .github/workflows YAML and need to ask "which lines
// are actually executable shell commands?" without pulling in a YAML parser
// (we deliberately keep the dependency graph small).
//
// The extractor is line-based and conservative: it recognises `run: <cmd>`,
// rejects `run: |` / `run: >` block headers (the commands live on subsequent
// lines and are picked up as bare command text), rejects comments and YAML
// keys, and lets unindented bare commands inside a `run: |` block fall
// through as commands.

export function getExecutableCommandText(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return null;
  }

  const runMatch = trimmed.match(/^(?:-\s*)?run:\s*(.*)$/);
  if (runMatch) {
    const command = (runMatch[1] ?? "").trim();
    if (/^[|>]/.test(command)) {
      return null;
    }
    return command;
  }

  if (/^(?:-\s*)?[A-Za-z0-9_-]+:\s*/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export interface ExecutableCommand {
  line: number;
  command: string;
}

export function getExecutableCommands(content: string): ExecutableCommand[] {
  const commands: ExecutableCommand[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    const command = getExecutableCommandText(line);
    if (!command) continue;
    if (/^echo\b/.test(command)) continue;
    commands.push({ line: index + 1, command });
  }
  return commands;
}

// Split a shell command on the four shell separators we care about: `&&`,
// `||`, `;`, `|`. Returns trimmed segments with empties dropped. Used to
// detect chained installs like `bun install --frozen-lockfile && bun install`
// where the second segment slips past the headline.
//
// Limitation: does not honour quoting, so a separator inside a string
// literal (`echo "a && b"`) is treated as a real separator and would
// over-segment. No current workflow command trips this; if one is added,
// either rewrite the command to avoid embedded separators or upgrade
// this splitter to a quote-aware tokenizer.
export function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function escapeRegex(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Boolean-flag detection that resists the common evasions:
//   `--frozen-lockfile=false`, `--frozen-lockfile=0`, `--no-frozen-lockfile`,
//   `--frozen-lockfileX`, `--frozen-lockfile-no`. A bare `\b--flag\b` regex
//   matches all of these because `-` is a non-word character (so `\b`
//   triggers between `\b--frozen-lockfile` and `=false` / `-no`).
//
// Returns true iff `flag` appears as a standalone token, optionally with
// an explicit truthy assignment (`--flag=true|1|yes|on`). Returns false
// for any of the disable / negation forms above.
export function hasBooleanFlagEnabled(segment: string, flag: string): boolean {
  const escaped = escapeRegex(flag);
  // Disable forms — `--no-flag` or `--flag=<falsy>` — always disqualify.
  if (new RegExp(`(?:^|\\s)--no-${escaped}(?:$|\\s|=)`).test(segment)) return false;
  if (new RegExp(`(?:^|\\s)--${escaped}=(?:false|0|no|off)\\b`, "i").test(segment)) return false;
  // Enable forms — bare token or `--flag=<truthy>` — qualify.
  if (new RegExp(`(?:^|\\s)--${escaped}(?:$|\\s)`).test(segment)) return true;
  if (new RegExp(`(?:^|\\s)--${escaped}=(?:true|1|yes|on)\\b`, "i").test(segment)) return true;
  return false;
}
