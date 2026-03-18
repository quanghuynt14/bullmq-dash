export function writeError(message: string, code: string, details?: string): void {
  process.stderr.write(JSON.stringify({ error: message, code, details }) + "\n");
}
