import { useState, useEffect, useCallback, useRef } from 'react';

const drafts = new Map<string, string>();

function makeDraftKey(sessionId: string, workerId: string): string {
  return `${sessionId}:${workerId}`;
}

export function useDraftMessage(sessionId: string, workerId: string | undefined) {
  const key = workerId ? makeDraftKey(sessionId, workerId) : null;
  const [content, setContentState] = useState(() => (key ? drafts.get(key) ?? '' : ''));
  const contentRef = useRef(content);
  const prevKeyRef = useRef(key);

  // Keep ref in sync with latest content
  contentRef.current = content;

  // When worker changes, save current draft and load the new one
  useEffect(() => {
    if (prevKeyRef.current === key) return;

    // Save draft for previous worker
    if (prevKeyRef.current) {
      if (contentRef.current) {
        drafts.set(prevKeyRef.current, contentRef.current);
      } else {
        drafts.delete(prevKeyRef.current);
      }
    }

    prevKeyRef.current = key;
    // Load draft for new worker
    setContentState(key ? drafts.get(key) ?? '' : '');
  }, [key]);

  // Keep the Map in sync whenever content changes
  const setContent = useCallback(
    (value: string | ((prev: string) => string)) => {
      setContentState((prev) => {
        const next = typeof value === 'function' ? value(prev) : value;
        if (key) {
          if (next) {
            drafts.set(key, next);
          } else {
            drafts.delete(key);
          }
        }
        return next;
      });
    },
    [key],
  );

  const clearDraft = useCallback(() => {
    if (key) {
      drafts.delete(key);
    }
    setContentState('');
  }, [key]);

  return { content, setContent, clearDraft } as const;
}

/**
 * Removes all draft entries for the given session.
 * Call when a session is deleted to prevent orphaned drafts.
 */
export function clearDraftsForSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of drafts.keys()) {
    if (key.startsWith(prefix)) {
      drafts.delete(key);
    }
  }
}

/** @internal Exported for testing */
export function _getDraftsMap(): Map<string, string> {
  return drafts;
}
