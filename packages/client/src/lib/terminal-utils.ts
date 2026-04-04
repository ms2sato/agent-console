/**
 * Interface representing the minimal buffer properties needed for scroll position checks.
 * This allows for easy mocking in tests without depending on the full xterm.js Terminal type.
 */
export interface TerminalBufferInfo {
  viewportY: number;
  length: number;
}

/**
 * Interface representing the minimal terminal properties needed for scroll position checks.
 */
export interface TerminalScrollInfo {
  buffer: {
    active: TerminalBufferInfo;
  };
  rows: number;
}

/**
 * Check if the terminal is scrolled to the bottom of the buffer.
 *
 * At bottom when: viewportY + rows >= buffer.length
 * - viewportY: the first visible line in the viewport
 * - buffer.length: total lines in the buffer
 * - rows: the number of visible rows
 *
 * @param terminal - Terminal instance or object with minimal scroll info
 * @returns true if scrolled to bottom, false otherwise
 */
export function isScrolledToBottom(terminal: TerminalScrollInfo): boolean {
  const buffer = terminal.buffer.active;
  return buffer.viewportY + terminal.rows >= buffer.length;
}

/**
 * Strip/replace scrollback-clearing escape sequences from terminal output.
 *
 * Performs two transformations:
 *   1. CSI 3J (Erase Scrollback) — removed entirely
 *   2. CSI 2J (Erase Display) — replaced with CSI H + CSI J
 *      (cursor home + erase from cursor to end of display),
 *      which clears the visible screen without pushing content into scrollback
 *
 * TUI programs like Claude Code send these sequences as part of screen redraws.
 * In a browser-based terminal manager, preserving scrollback is more valuable
 * than honoring scrollback-clear requests.
 */
/**
 * Strip system messages from terminal output.
 *
 * Removes two kinds of messages that are intended for the AI agent, not the human viewer:
 *
 * 1. `[internal:*]` lines — e.g. `[internal:timer] timestamp=... intent=inform`
 * 2. `[Reply Instructions]` blocks — multi-line blocks with `- toSessionId:` / `- fromSessionId:` continuation lines
 *
 * Claude Code renders these with ANSI escape codes (e.g. `\x1b[1m\x1b[33m[internal:timer]\x1b[0m ...`),
 * so the patterns tolerate optional ANSI SGR sequences (`\x1b[...m`) before the bracket.
 */

/** Matches any number of ANSI CSI sequences (SGR like `\x1b[0m`, and non-SGR like `\x1b[2K`). */
const ANSI = '(?:\\x1b\\[[0-9;]*[A-Za-z])*';

/**
 * Matches an `[internal:*]` line with optional ANSI codes before the bracket.
 * Two alternations:
 *   1. Mid-string: consumes leading \r?\n (removes the line separator before the system line)
 *   2. Start-of-string: consumes trailing \r?\n (removes the line separator after the system line)
 * Uses [^\r\n]* to avoid eating \r from \r\n line endings.
 */
const INTERNAL_RE = new RegExp(
  `\\r?\\n${ANSI}\\[internal:[^\\]]*\\][^\\r\\n]*|^${ANSI}\\[internal:[^\\]]*\\][^\\r\\n]*\\r?\\n?`,
  'g',
);

/** Matches a `[Reply Instructions]` block including continuation lines (`- ...`). */
const REPLY_INSTRUCTIONS_RE = new RegExp(
  `\\r?\\n${ANSI}\\[Reply Instructions\\][^\\r\\n]*(?:\\r?\\n${ANSI}- [^\\r\\n]*)*|^${ANSI}\\[Reply Instructions\\][^\\r\\n]*(?:\\r?\\n${ANSI}- [^\\r\\n]*)*\\r?\\n?`,
  'g',
);

export function stripSystemMessages(data: string): string {
  return data.replace(INTERNAL_RE, '').replace(REPLY_INSTRUCTIONS_RE, '');
}

export function stripScrollbackClear(data: string): string {
  return data.replaceAll('\x1b[3J', '').replaceAll('\x1b[2J', '\x1b[H\x1b[J');
}
