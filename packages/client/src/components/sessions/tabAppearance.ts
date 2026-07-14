import type { Worker } from '@agent-console/shared';

/**
 * Tailwind background-color class for a tab's status dot. `git-diff` tabs
 * render an icon instead of a dot (the caller branches on that before
 * calling this), so the `git-diff` case here is a defensive default only.
 */
export function getTabDotColor(workerType: Worker['type']): string {
  switch (workerType) {
    case 'agent':
      return 'bg-blue-500';
    case 'embedded-agent':
      return 'bg-purple-500';
    case 'terminal':
    case 'git-diff':
      return 'bg-green-500';
    default: {
      const _exhaustive: never = workerType;
      return _exhaustive;
    }
  }
}

/**
 * Worker types whose tab renders a close ("x") button: opt-in workers a user
 * added to a running session and can remove again. `agent` and `git-diff`
 * are fixed tabs (auto-created with the session) and are never closeable --
 * see `useTabManagement.ts`'s `closeTab` guard for the server-side mirror of
 * this rule.
 */
export function isCloseableTabType(workerType: Worker['type']): boolean {
  return workerType === 'terminal' || workerType === 'embedded-agent';
}

/**
 * Worker types whose active tab shows the Idle/Working/Waiting-for-input
 * activity badge in the shared bottom status bar. `agent` and
 * `embedded-agent` both drive `activityState` via the app-wide
 * `worker-activity` WebSocket event (see `useSessionPageState.ts`); other
 * worker types (`terminal`, `git-diff`) have no comparable activity concept.
 */
export function showsActivityBadge(workerType: Worker['type']): boolean {
  return workerType === 'agent' || workerType === 'embedded-agent';
}

/** Human-readable label for a worker type, used by `WorkerErrorFallback`'s
 * "<Type> Error: <name>" heading in `SessionPage.tsx`. */
export function getWorkerTypeLabel(workerType: Worker['type']): string {
  switch (workerType) {
    case 'git-diff':
      return 'Diff View';
    case 'agent':
      return 'Agent';
    case 'terminal':
      return 'Terminal';
    case 'embedded-agent':
      return 'Embedded Agent';
    default: {
      const _exhaustive: never = workerType;
      return _exhaustive;
    }
  }
}
