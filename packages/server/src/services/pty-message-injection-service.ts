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

  /** Bracketed paste mode delimiters (DEC private mode 2004). */
  private static readonly PASTE_START = '\x1b[200~';
  private static readonly PASTE_END = '\x1b[201~';

  /** Wrap a single injected part in bracketed paste delimiters. */
  private wrapPaste(part: string): string {
    return `${PtyMessageInjectionService.PASTE_START}${part}${PtyMessageInjectionService.PASTE_END}`;
  }

  /**
   * Build message parts from content and file paths, then inject into PTY.
   * Content newlines (CRLF or LF from browser form submissions) are normalized
   * to LF so they remain soft newlines inside the message body — only the
   * final delayed CR (\r) acts as the submit keystroke. Remaining parts and
   * a final Enter are queued with delays so TUI agents can process each
   * input sequentially.
   *
   * Each injected content/file part is wrapped in bracketed paste delimiters
   * (`ESC[200~` … `ESC[201~`). Modern TUIs (e.g. recent Claude Code, which
   * enables `ESC[?2004h`) discard multi-character non-pasted input on the
   * interactive prompt, so unwrapped raw text was silently dropped and only
   * the trailing bare `\r` reached the prompt. The normalized LF newlines end
   * up inside the bracketed paste envelope, where they are literal text and
   * never submit — the final separate `\r` remains the only submit keystroke.
   * See Issue #792.
   *
   * See Issue #660: previously this converted \r?\n to \r, which caused any
   * embedded newline to be interpreted as submit and split a single message
   * into multiple submissions.
   *
   * Returns true if the first part was successfully written, false otherwise.
   */
  injectMessage(sessionId: string, workerId: string, content: string, filePaths?: string[]): boolean {
    const parts: string[] = [];
    if (content) parts.push(content.replace(/\r?\n/g, '\n'));
    if (filePaths && filePaths.length > 0) {
      parts.push(...filePaths);
    }

    if (parts.length === 0) {
      logger.warn({ sessionId, workerId }, 'No content or files to send');
      return false;
    }

    const injected = this.writeInput(sessionId, workerId, this.wrapPaste(parts[0]));
    if (!injected) {
      logger.warn({ sessionId, workerId }, 'Failed to inject worker message (PTY inactive)');
      return false;
    }

    // Queue remaining parts and final Enter with delays
    // Use longer delays to ensure TUI processes each input before the next
    const sendQueue: Array<() => void> = [];

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      // Leading \r submits the *previous* part (unwrapped); only the part
      // content itself is wrapped in bracketed paste delimiters.
      sendQueue.push(() => this.writeInput(sessionId, workerId, `\r${this.wrapPaste(part)}`));
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
