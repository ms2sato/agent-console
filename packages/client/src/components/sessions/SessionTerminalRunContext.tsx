import { createContext, useContext } from 'react';

export interface SessionTerminalRun {
  /** The current session's terminal workers, in server order. */
  terminalWorkers: ReadonlyArray<{ id: string; name: string }>;
  /** Switches the session's active worker tab to the given worker. */
  activateWorker: (workerId: string) => void;
  /**
   * Creates a terminal worker (which also becomes the active tab). Resolves to
   * null when nothing was created; the failure has already been surfaced.
   */
  createTerminalWorker: () => Promise<{ id: string; name: string } | null>;
}

// Null outside a session page: consumers (the memo panel) then offer no Run control.
export const SessionTerminalRunContext = createContext<SessionTerminalRun | null>(null);

export function useSessionTerminalRun(): SessionTerminalRun | null {
  return useContext(SessionTerminalRunContext);
}
