/**
 * Helper for tests asserting the prompt content reached the spawn boundary.
 *
 * After Issue #851, `expandTemplate` embeds the `{{prompt}}` placeholder
 * directly into the spawned command string via `shellEscape` (single-quoted
 * literal with `'\''` for embedded single quotes), instead of indirecting
 * through `env.__AGENT_PROMPT__`. Tests that previously read the prompt
 * from the spawn options' `env` field must now extract it from the command
 * string.
 *
 * `extractPromptFromSpawnCommand` finds the LAST single-quoted run in the
 * command — agent headless templates always place `{{prompt}}` last
 * (e.g. `claude -p --format text {{prompt}}`), and `shellEscape` always
 * wraps its argument in `'...'` and never produces a bare `'` outside the
 * wrap. The helper then reverses the `'\''` escape that `shellEscape`
 * inserts for embedded single quotes.
 */
export function extractPromptFromSpawnCommand(command: string): string {
  // Match the LAST single-quoted run, allowing the `'\''` escape sequence
  // inside (which `shellEscape` produces for embedded single quotes).
  // The regex content `(?:[^']|'\\'')*` accepts non-quote chars or the
  // literal 4-char sequence `'\''`.
  const match = command.match(/'((?:[^']|'\\'')*)'\s*$/);
  if (!match) {
    throw new Error(`could not extract prompt from command: ${command}`);
  }
  // Unescape the `'\''` sequence back to a literal single quote.
  return match[1].replace(/'\\''/g, "'");
}
