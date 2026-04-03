import { createLogger } from '../lib/logger.js';

const logger = createLogger('pty-message-injection');

/** Callback to write data to a worker's PTY. Returns true if the write succeeded. */
type PtyWriter = (sessionId: string, workerId: string, data: string) => boolean;

/** Callback to check if a worker is still active (session exists and worker exists). */
type WorkerActiveChecker = (sessionId: string, workerId: string) => boolean;

export class PtyMessageInjectionService {
  static readonly DELAY_MS = 150;

  constructor(
    private readonly writeInput: PtyWriter,
    private readonly isWorkerActive: WorkerActiveChecker,
  ) {}

  /**
   * Build message parts from content and file paths, then inject into PTY.
   * Content newlines are converted to carriage returns for TUI compatibility.
   * Remaining parts and a final Enter are queued with delays so TUI agents
   * can process each input sequentially.
   *
   * Returns true if the first part was successfully written, false otherwise.
   */
  injectMessage(sessionId: string, workerId: string, content: string, filePaths?: string[]): boolean {
    const parts: string[] = [];
    if (content) parts.push(content.replace(/\r?\n/g, '\r'));
    if (filePaths && filePaths.length > 0) {
      parts.push(...filePaths);
    }

    if (parts.length === 0) {
      logger.warn({ sessionId, workerId }, 'No content or files to send');
      return false;
    }

    const injected = this.writeInput(sessionId, workerId, parts[0]);
    if (!injected) {
      logger.warn({ sessionId, workerId }, 'Failed to inject worker message (PTY inactive)');
      return false;
    }

    // Queue remaining parts and final Enter with delays
    // Use longer delays to ensure TUI processes each input before the next
    const sendQueue: Array<() => void> = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      sendQueue.push(() => this.writeInput(sessionId, workerId, `\r${part}`));
    }
    // Final Enter to submit
    sendQueue.push(() => this.writeInput(sessionId, workerId, '\r'));

    // Execute queue with delays
    sendQueue.forEach((fn, i) => {
      setTimeout(() => {
        if (!this.isWorkerActive(sessionId, workerId)) {
          logger.debug({ sessionId, workerId }, 'Skipping delayed sendMessage write: session or worker no longer exists');
          return;
        }
        fn();
      }, PtyMessageInjectionService.DELAY_MS * (i + 1));
    });

    return true;
  }
}
