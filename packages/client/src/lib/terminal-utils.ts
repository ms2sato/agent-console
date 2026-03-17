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
 * Strip CSI 3J (Erase Scrollback) escape sequence from terminal output.
 *
 * TUI programs like Claude Code send \x1b[3J as part of screen redraws,
 * which clears the xterm.js scrollback buffer and resets scroll position to top.
 * In a browser-based terminal manager, preserving scrollback is more valuable
 * than honoring scrollback-clear requests.
 */
export function stripScrollbackClear(data: string): string {
  return data.replaceAll('\x1b[3J', '');
}
