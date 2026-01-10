import type { AgentActivityState } from '@agent-console/shared';

const FAVICON_NORMAL = '/favicon.svg';
const FAVICON_WAITING = '/favicon-waiting.svg';

let currentFaviconPath: string | null = null;

/**
 * Update favicon based on whether any worker is in 'asking' state
 */
export function updateFavicon(hasAskingWorker: boolean): void {
  const newPath = hasAskingWorker ? FAVICON_WAITING : FAVICON_NORMAL;

  // Skip if already set to this path
  if (currentFaviconPath === newPath) {
    return;
  }

  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    link.href = newPath;
    currentFaviconPath = newPath;
  }
}

/**
 * Check if any worker across all sessions is in 'asking' state
 */
export function hasAnyAskingWorker(
  workerActivityStates: Record<string, Record<string, AgentActivityState>>
): boolean {
  for (const sessionId of Object.keys(workerActivityStates)) {
    const workers = workerActivityStates[sessionId];
    for (const workerId of Object.keys(workers)) {
      if (workers[workerId] === 'asking') {
        return true;
      }
    }
  }
  return false;
}
