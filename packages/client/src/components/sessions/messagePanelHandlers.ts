/**
 * PTY-worker MessagePanel wiring, extracted from SessionPage.
 *
 * Extracted from SessionPage to enable direct unit testing without React
 * component rendering, following the same pattern as workerRestart.ts /
 * tabAppearance.ts / tabKeyboardNavigation.ts.
 */
import { sendWorkerMessage } from '../../lib/api';
import { getOrCreateTerminal } from '../terminal/terminal-store';

/** Send a message to a PTY-backed agent worker via the HTTP transport. */
export async function sendPtyWorkerMessage(
  sessionId: string,
  targetWorkerId: string,
  content: string,
  files?: File[],
): Promise<void> {
  await sendWorkerMessage(sessionId, targetWorkerId, content, files);
}

/** Route an ESC keypress to the PTY-backed worker's terminal instance. */
export function escapePtyWorker(sessionId: string, targetWorkerId: string): void {
  getOrCreateTerminal(sessionId, targetWorkerId).sendInput('\x1b');
}
