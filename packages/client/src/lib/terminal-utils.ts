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
 * Strip system messages (`[internal:*]`) from terminal output.
 *
 * These messages are intended for the AI agent, not the human viewer.
 * The pattern matches newline-prefixed `[internal:...]` followed by any
 * content until the next newline, so they are removed from xterm.js display
 * while remaining available to the agent via PTY.
 */
export function stripSystemMessages(data: string): string {
  return data.replace(/\n\[internal:[^\]]*\][^\n]*/g, '');
}

export function stripScrollbackClear(data: string): string {
  return data.replaceAll('\x1b[3J', '').replaceAll('\x1b[2J', '\x1b[H\x1b[J');
}
