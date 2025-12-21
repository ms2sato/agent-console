import type { Terminal } from '@xterm/xterm';

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
