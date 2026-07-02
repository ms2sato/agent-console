/**
 * Custom key event handler for the xterm.js terminal.
 *
 * Extracted from `Terminal.tsx` so the handler logic is directly importable
 * and unit-testable without rendering the full Terminal component.
 */
export interface TerminalKeyHandlerDeps {
  sendInput: (data: string) => void;
  selectAll: () => void;
}

export function createCustomKeyEventHandler(
  deps: TerminalKeyHandlerDeps,
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent) => {
    // Skip IME composition events (Japanese input, etc.)
    if (event.isComposing) {
      return true; // Let IME handle it
    }

    // Cmd+A: select the whole buffer so Cmd+C can copy it even while a
    // TUI has mouse tracking enabled (selectAll bypasses the disabled
    // selection service). Ctrl+A is deliberately NOT intercepted: it is
    // readline's beginning-of-line and must keep reaching the PTY.
    if (
      event.type === 'keydown' &&
      event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
      event.key.toLowerCase() === 'a'
    ) {
      event.preventDefault();
      deps.selectAll();
      return false;
    }

    // Handle Shift+Enter for multi-line input
    if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      // Send soft newline for multi-line input
      deps.sendInput('\x0a');
      return false; // Prevent terminal from handling
    }

    return true; // Allow default handling for other keys
  };
}
