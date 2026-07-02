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
