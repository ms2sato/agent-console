import type { InteractiveProcessInfo } from '@agent-console/shared';
import type { Subprocess, FileSink } from 'bun';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('interactive-process-manager');

export const MAX_PROCESSES_PER_SESSION = 10;

interface StoredProcess {
  info: InteractiveProcessInfo;
  subprocess: Subprocess<'pipe', 'pipe', 'pipe'>;
  stdin: FileSink;
  /** Resolves when both stdout and stderr have been fully read and flushed. */
  streamsDone: Promise<void>;
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

interface OutputBuffer {
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

export class InteractiveProcessManager {
  /** Debounce delay for buffering process output before calling onOutput. */
  static readonly DEBOUNCE_OUTPUT_MS = 150;

  private processes = new Map<string, StoredProcess>();
  private outputBuffers = new Map<string, OutputBuffer>();
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

    // Track stream completion so the exit handler can wait for all output to flush.
    const streamsDone = Promise.all([
      this.readStream(id, subprocess.stdout).catch((err) => {
        logger.warn({ processId: id, err }, 'stdout read stream error');
      }),
      this.readStream(id, subprocess.stderr).catch((err) => {
        logger.warn({ processId: id, err }, 'stderr read stream error');
      }),
    ]).then(() => {});

    const stored: StoredProcess = {
      info,
      subprocess,
      stdin: subprocess.stdin,
      streamsDone,
    };
    this.processes.set(id, stored);

    // Monitor process exit — wait for streams to be fully read before calling onExit.
    // This prevents the race where subprocess.exited resolves before readStream
    // finishes flushing output, which would cause the delayed \r from
    // writePtyNotification (sent by onOutput) to arrive after the exit notification.
    subprocess.exited.then(async (exitCode) => {
      const current = this.processes.get(id);
      if (current) {
        await current.streamsDone;
        current.info.status = 'exited';
        current.info.exitCode = exitCode;
        logger.info({ processId: id, exitCode }, 'Process exited');
        this.onExit({ ...current.info });
      }
    }).catch((err) => {
      logger.error({ processId: id, err }, 'Process exit handler error');
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
          this.bufferOutput(processId, text);
        }
      }
    } catch (err) {
      logger.debug({ processId, err }, 'Stream read ended');
    }
    // Flush any remaining buffered output when stream ends
    this.flushOutputBuffer(processId);
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
      // The Enter (\r) will be sent by writePtyNotification when process
      // output settles and onOutput is called.
      if (this.ptyMessageInjector) {
        this.ptyMessageInjector.writePtyData(
          stored.info.sessionId,
          stored.info.workerId,
          content.replace(/\r?\n/g, '\r'),
        );
      }

      // Write content followed by null byte (\0) to unblock the script's stdin reader.
      // Process output will arrive via readStream → bufferOutput → debounce →
      // flush → onOutput → writePtyNotification → \r
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

    this.clearOutputBuffer(processId);

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
        this.clearOutputBuffer(id);
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
    for (const buffer of this.outputBuffers.values()) {
      clearTimeout(buffer.timer);
    }
    this.outputBuffers.clear();

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

  private bufferOutput(processId: string, text: string): void {
    let buffer = this.outputBuffers.get(processId);
    if (!buffer) {
      buffer = { text: '', timer: setTimeout(() => this.flushOutputBuffer(processId), InteractiveProcessManager.DEBOUNCE_OUTPUT_MS) };
      this.outputBuffers.set(processId, buffer);
    } else {
      clearTimeout(buffer.timer);
      buffer.timer = setTimeout(() => this.flushOutputBuffer(processId), InteractiveProcessManager.DEBOUNCE_OUTPUT_MS);
    }
    buffer.text += text;
  }

  private flushOutputBuffer(processId: string): void {
    const buffer = this.outputBuffers.get(processId);
    if (!buffer) return;

    clearTimeout(buffer.timer);
    const text = buffer.text;
    this.outputBuffers.delete(processId);

    if (text) {
      const stored = this.processes.get(processId);
      if (stored) {
        this.onOutput({ ...stored.info }, text);
      }
    }
  }

  private clearOutputBuffer(processId: string): void {
    const buffer = this.outputBuffers.get(processId);
    if (buffer) {
      clearTimeout(buffer.timer);
      this.outputBuffers.delete(processId);
    }
  }
}
