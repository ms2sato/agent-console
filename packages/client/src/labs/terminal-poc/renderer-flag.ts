import { useSyncExternalStore } from 'react';

/**
 * Per-browser terminal renderer selection (fallback flag for the labs-terminal
 * swap, roadmap PR-4). `SessionPage` picks the production `Terminal` or the PoC
 * `PocTerminalAdapter` from this value.
 */
export const TERMINAL_RENDERERS = ['legacy', 'next'] as const;
export type TerminalRenderer = (typeof TERMINAL_RENDERERS)[number];

/**
 * Build-time fleet default. This is the ONE-LINE switch for the whole fleet:
 * flip it to `'next'` to make the labs renderer the default for every browser
 * that has not explicitly chosen one, and flip it back to `'legacy'` for the
 * emergency revert (no data loss — the next renderer reconstructs all state from
 * server history). A browser's explicit Settings choice overrides this default.
 */
export const DEFAULT_TERMINAL_RENDERER: TerminalRenderer = 'legacy';

const STORAGE_KEY = 'terminal-renderer';

// localStorage is not reactive within a tab, so the store notifies its own
// subscribers on every write; useSyncExternalStore then re-reads the snapshot.
const listeners = new Set<() => void>();

function isTerminalRenderer(value: unknown): value is TerminalRenderer {
  return value === 'legacy' || value === 'next';
}

export function getTerminalRenderer(): TerminalRenderer {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTerminalRenderer(stored)) return stored;
  } catch {
    // localStorage unavailable (privacy mode, sandboxed context): use the default.
  }
  return DEFAULT_TERMINAL_RENDERER;
}

export function setTerminalRenderer(value: TerminalRenderer): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Write blocked (privacy mode): still notify so the choice takes effect for
    // this tab session, even though it will not persist across reloads.
  }
  for (const listener of listeners) listener();
}

export function subscribeTerminalRenderer(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useTerminalRenderer(): TerminalRenderer {
  // getSnapshot returns a primitive string, so useSyncExternalStore's identity
  // check is by value — no cached-snapshot dance needed.
  return useSyncExternalStore(
    subscribeTerminalRenderer,
    getTerminalRenderer,
    getTerminalRenderer,
  );
}
