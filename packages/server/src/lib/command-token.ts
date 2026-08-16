/**
 * Extract the display token (the program name) from an EXPANDED agent
 * commandTemplate -- the string `expandTemplate` returns, before any of
 * this server's own env/sentinel wrapping (see `UserMode.spawnPty` /
 * `sentinel-spawn-command.ts`). Using the wrapped shell string instead
 * would name our own plumbing ("env" / "sh") rather than the agent's
 * command.
 *
 * Skips leading `VAR=value` shell-assignment-style tokens (a template idiom
 * some custom agents use, e.g. `FOO=bar mycommand args`) so the returned
 * token names the actual program. Falls back to the full command string
 * when extraction is ambiguous -- no non-assignment token found, or the
 * candidate still contains a literal `{{` (an unexpanded placeholder) --
 * so callers always have something reasonable to display rather than a
 * misleading truncation.
 */
export function extractCommandToken(expandedCommand: string): string {
  const tokens = expandedCommand.trim().split(/\s+/).filter(Boolean);
  const isAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
  const candidate = tokens.find((token) => !isAssignment(token));

  if (candidate === undefined || candidate.includes('{{')) {
    return expandedCommand;
  }
  return candidate;
}
