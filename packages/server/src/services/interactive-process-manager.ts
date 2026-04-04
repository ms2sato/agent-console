import type { InteractiveProcessInfo } from '@agent-console/shared';
import type { Subprocess, FileSink } from 'bun';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('interactive-process-manager');

export const MAX_PROCESSES_PER_SESSION = 10;

interface StoredProcess {
  info: InteractiveProcessInfo;
  subprocess: Subprocess<'pipe', 'pipe', 'pipe'>;
  stdin: FileSink;
}

export interface ProcessOutputCallback {
  (process: InteractiveProcessInfo, output: string): void;
}

export interface ProcessExitCallback {
  (process: InteractiveProcessInfo): void;
}

/** Service that can inject content into a worker's PTY as submitted input. */
export interface PtyMessageInjector {
  injectPtyMessage(sessionId: string, workerId: string, content: string): boolean;
  /** Write raw data to a worker's PTY (no CR conversion, no delayed Enter). */
  writePtyData(sessionId: string, workerId: string, data: string): boolean;
}

export class InteractiveProcessManager {
  /** Debounce delay for sending Enter after process output settles. */
  static readonly DEBOUNCE_ENTER_MS = 150;

  private processes = new Map<string, StoredProcess>();
  private pendingEnters = new Map<string, ReturnType<typeof setTimeout>>();
  private onOutput: ProcessOutputCallback;
  private onExit: ProcessExitCallback;
  private ptyMessageInjector?: PtyMessageInjector;

  constructor(onOutput: ProcessOutputCallback, onExit: ProcessExitCallback, ptyMessageInjector?: PtyMessageInjector) {
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.ptyMessageInjector = ptyMessageInjector;
  }

  async runProcess(params: {
    sessionId: string;
    workerId: string;
    command: string;
    cwd?: string;
  }): Promise<InteractiveProcessInfo> {
    const { sessionId, workerId, command, cwd } = params;

    const sessionProcessCount = this.listProcesses(sessionId).filter(
      (p) => p.status === 'running',
    ).length;
    if (sessionProcessCount >= MAX_PROCESSES_PER_SESSION) {
      throw new Error(
        `Session ${sessionId} already has ${sessionProcessCount} running processes (max ${MAX_PROCESSES_PER_SESSION})`,
      );
    }

    const id = crypto.randomUUID();
    const info: InteractiveProcessInfo = {
      id,
      sessionId,
      workerId,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    const subprocess = Bun.spawn(['sh', '-c', command], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd,
    });

    const stored: StoredProcess = {
      info,
      subprocess,
      stdin: subprocess.stdin,
    };
    this.processes.set(id, stored);

    // Read stdout asynchronously
    this.readStream(id, subprocess.stdout);
    // Also capture stderr and send as output
    this.readStream(id, subprocess.stderr);

    // Monitor process exit
    subprocess.exited.then((exitCode) => {
      const current = this.processes.get(id);
      if (current) {
        current.info.status = 'exited';
        current.info.exitCode = exitCode;
        logger.info({ processId: id, exitCode }, 'Process exited');
        this.onExit({ ...current.info });
      }
    });

    logger.info(
      { processId: id, sessionId, workerId, command },
      'Process started',
    );

    return { ...info };
  }

  private async readStream(
    processId: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) {
          const stored = this.processes.get(processId);
          if (stored) {
            this.onOutput({ ...stored.info }, text);
            // Reset debounced Enter: process output just wrote to PTY,
            // wait for output to settle before sending \r
            this.resetDebouncedEnter(processId);
          }
        }
      }
    } catch (err) {
      logger.debug({ processId, err }, 'Stream read ended');
    }
  }

  async writeResponse(processId: string, content: string): Promise<boolean> {
    const stored = this.processes.get(processId);
    if (!stored) {
      return false;
    }
    if (stored.info.status !== 'running') {
      return false;
    }

    try {
      // Echo response content to worker PTY (CR-converted, no Enter yet).
      // The Enter (\r) is sent via debounce after process output settles.
      if (this.ptyMessageInjector) {
        this.ptyMessageInjector.writePtyData(
          stored.info.sessionId,
          stored.info.workerId,
          content.replace(/\r?\n/g, '\r'),
        );
      }

      // Schedule debounced Enter — will be reset each time process output
      // writes to the PTY, and fires once output settles.
      this.scheduleDebouncedEnter(processId);

      // Write content followed by null byte (\0) to unblock the script's stdin reader.
      // This must not be delayed — process output triggers PTY writes that reset the debounce.
      stored.stdin.write(content + '\0');
      stored.stdin.flush();

      logger.debug({ processId, contentLength: content.length }, 'Wrote response to process');
      return true;
    } catch (err) {
      logger.warn({ processId, err }, 'Failed to write to process stdin');
      return false;
    }
  }

  killProcess(processId: string): boolean {
    const stored = this.processes.get(processId);
    if (!stored) {
      return false;
    }

    this.clearPendingEnter(processId);

    try {
      stored.subprocess.kill(15); // SIGTERM
    } catch {
      // Process may have already exited
    }

    stored.info.status = 'exited';
    this.processes.delete(processId);
    logger.info({ processId }, 'Process killed');
    return true;
  }

  getProcess(processId: string): InteractiveProcessInfo | undefined {
    const stored = this.processes.get(processId);
    return stored ? { ...stored.info } : undefined;
  }

  listProcesses(sessionId?: string): InteractiveProcessInfo[] {
    const all = Array.from(this.processes.values(), (stored) => ({
      ...stored.info,
    }));
    if (sessionId === undefined) {
      return all;
    }
    return all.filter((info) => info.sessionId === sessionId);
  }

  deleteProcessesBySession(sessionId: string): number {
    let count = 0;
    for (const [id, stored] of this.processes) {
      if (stored.info.sessionId === sessionId) {
        this.clearPendingEnter(id);
        try {
          stored.subprocess.kill(15);
        } catch {
          // Process may have already exited
        }
        this.processes.delete(id);
        count += 1;
      }
    }
    if (count > 0) {
      logger.info({ sessionId, count }, 'Deleted processes for session');
    }
    return count;
  }

  disposeAll(): void {
    for (const timer of this.pendingEnters.values()) {
      clearTimeout(timer);
    }
    this.pendingEnters.clear();

    for (const stored of this.processes.values()) {
      try {
        stored.subprocess.kill(15);
      } catch {
        // Process may have already exited
      }
    }
    const count = this.processes.size;
    this.processes.clear();
    logger.info({ count }, 'All processes disposed');
  }

  private scheduleDebouncedEnter(processId: string): void {
    this.clearPendingEnter(processId);
    const timer = setTimeout(() => {
      this.pendingEnters.delete(processId);
      const stored = this.processes.get(processId);
      if (stored && this.ptyMessageInjector) {
        this.ptyMessageInjector.writePtyData(
          stored.info.sessionId,
          stored.info.workerId,
          '\r',
        );
      }
    }, InteractiveProcessManager.DEBOUNCE_ENTER_MS);
    this.pendingEnters.set(processId, timer);
  }

  private resetDebouncedEnter(processId: string): void {
    if (this.pendingEnters.has(processId)) {
      this.scheduleDebouncedEnter(processId);
    }
  }

  private clearPendingEnter(processId: string): void {
    const timer = this.pendingEnters.get(processId);
    if (timer) {
      clearTimeout(timer);
      this.pendingEnters.delete(processId);
    }
  }
}
