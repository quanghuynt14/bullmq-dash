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
export function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}
