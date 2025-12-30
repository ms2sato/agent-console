import type { Terminal } from '@xterm/xterm';

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
 * Clear terminal and write data, preserving scroll position.
 * The writeFn should return a Promise that resolves when the last write completes.
 */
export const clearAndWrite = async (
  terminal: Terminal,
  writeFn: () => Promise<void>
): Promise<void> => {
  const scrollPosition = terminal.buffer.active.viewportY;
  terminal.clear();
  await writeFn();
  terminal.scrollToLine(scrollPosition);
};
