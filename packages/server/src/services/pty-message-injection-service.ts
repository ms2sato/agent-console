import { createLogger } from '../lib/logger.js';

const logger = createLogger('pty-message-injection');

/** Callback to write data to a worker's PTY. Returns true if the write succeeded. */
type PtyWriter = (sessionId: string, workerId: string, data: string) => boolean;

/** Callback to check if a worker is still active (session exists and worker exists). */
type WorkerActiveChecker = (sessionId: string, workerId: string) => boolean;

export class PtyMessageInjectionService {
  static readonly DELAY_MS = 150;

  /** ESC keystroke used to cancel an active interactive prompt before delivering text. */
  private static readonly ESC = '\x1b';

  constructor(
    private readonly writeInput: PtyWriter,
    private readonly isWorkerActive: WorkerActiveChecker,
  ) {}

  /**
   * Build message parts from content and file paths, then inject into PTY.
   * Content newlines (CRLF or LF from browser form submissions) are normalized
   * to LF so they remain soft newlines inside the message body — only the
   * final delayed CR (\r) acts as the submit keystroke. Remaining parts and
   * a final Enter are queued with delays so TUI agents can process each
   * input sequentially.
   *
   * Previously this converted \r?\n to \r, which caused any embedded newline
   * to be interpreted as submit and split a single message into multiple
   * submissions.
   *
   * When `isAsking` is true the agent is parked at an interactive
   * prompt (the "asking" activity state). Modern Claude Code CLIs drop text typed
   * while such a prompt is open — the bare submit CR then confirms the default
   * option instead of delivering the message. To handle this we send an ESC first
   * to cancel the active prompt, then deliver the text as a normal composer
   * message. Older CLIs cancelled the prompt implicitly; modern CLIs dropped that
   * leniency. ESC is sent only in the asking state — the non-asking path is
   * unchanged from before.
   *
   * Returns true if the first part was successfully written, false otherwise.
   */
  injectMessage(
    sessionId: string,
    workerId: string,
    content: string,
    filePaths?: string[],
    isAsking = false,
  ): boolean {
    const parts: string[] = [];
    if (content) parts.push(content.replace(/\r?\n/g, '\n'));
    if (filePaths && filePaths.length > 0) {
      parts.push(...filePaths);
    }

    if (parts.length === 0) {
      logger.warn({ sessionId, workerId }, 'No content or files to send');
      return false;
    }

    // In the asking state, send ESC first (synchronously) to cancel the prompt;
    // otherwise send the first content part immediately as before.
    const firstWrite = isAsking ? PtyMessageInjectionService.ESC : parts[0];
    const ok = this.writeInput(sessionId, workerId, firstWrite);
    if (!ok) {
      logger.warn({ sessionId, workerId }, 'Failed to inject worker message (PTY inactive)');
      return false;
    }

    // Queue remaining parts and final Enter with delays
    // Use longer delays to ensure TUI processes each input before the next
    const sendQueue: Array<() => void> = [];

    if (isAsking) {
      // The first content part runs after the initial delay so the prompt has
      // time to close after the ESC was sent synchronously above.
      sendQueue.push(() => this.writeInput(sessionId, workerId, parts[0]));
    }

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
