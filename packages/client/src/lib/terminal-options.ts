/**
 * Base constructor options for the xterm.js terminal.
 *
 * Extracted from `Terminal.tsx` so the option contract is directly importable
 * (and therefore unit-testable) instead of being introspected from source text.
 */
import type { ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm';

export function buildBaseTerminalOptions(): ITerminalOptions & ITerminalInitOnlyOptions {
  return {
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "DejaVu Sans Mono", Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1a1a2e',
      foreground: '#eee',
      cursor: '#eee',
    },
  };
}
