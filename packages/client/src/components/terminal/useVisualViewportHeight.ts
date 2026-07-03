import { useSyncExternalStore } from 'react';

/**
 * Tracks the visual viewport height. On mobile the visual viewport shrinks when
 * the soft keyboard opens (unlike window.innerHeight / layout viewport), so the
 * The terminal page uses this value as its root height to keep the input bar above the
 * keyboard instead of hidden behind it.
 */

function subscribe(listener: () => void): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) {
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', listener);
      return () => window.removeEventListener('resize', listener);
    }
    return () => {};
  }
  vv.addEventListener('resize', listener);
  vv.addEventListener('scroll', listener);
  return () => {
    vv.removeEventListener('resize', listener);
    vv.removeEventListener('scroll', listener);
  };
}

function getSnapshot(): number {
  if (typeof window === 'undefined') return 0;
  return window.visualViewport?.height ?? window.innerHeight;
}

function getServerSnapshot(): number {
  return 0;
}

export function useVisualViewportHeight(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
