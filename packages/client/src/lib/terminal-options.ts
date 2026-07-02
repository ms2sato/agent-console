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
    // Allow Option+drag selection even while a TUI (e.g. Claude Code's
    // fullscreen UI) has DEC mouse tracking enabled. Without this, macOS
    // has no bypass at all: xterm.js only honors Shift+drag on non-Mac
    // platforms (SelectionService.shouldForceSelection).
    macOptionClickForcesSelection: true,
    // Off by default only on non-Mac. On Mac this defaults to true and a
    // right-click outside the current selection replaces it with a
    // one-word selection, destroying the "select -> right-click -> Copy"
    // flow. Disabling keeps the existing selection for the context menu.
    rightClickSelectsWord: false,
    // With macOptionClickForcesSelection enabled, a short Option+click
    // would otherwise emit cursor-move escape sequences (arrow keys) into
    // the PTY (SelectionService alt-click handling) — stray input for the
    // running CLI. Disable it; the feature only ever worked while mouse
    // tracking was off.
    altClickMovesCursor: false,
  };
}
