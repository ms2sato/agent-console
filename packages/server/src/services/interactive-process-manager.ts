import type { InteractiveProcessInfo, InteractiveProcessOutputMode } from '@agent-console/shared';
import type { Subprocess, FileSink } from 'bun';
import { createLogger } from '../lib/logger.js';
import {
  spawnAsUser,
  runAsUser,
  discoverElevatedPgid,
  killProcessGroupAsUser,
  type SpawnAsUserFn,
} from './privilege-elevation.js';
import { buildAgentConsoleEnv } from './agent-console-env.js';
import { serverConfig } from '../lib/server-config.js';
import { MESSAGE_CHUNK_TARGET_BYTES } from './process-output-router.js';

const logger = createLogger('interactive-process-manager');

export const MAX_PROCESSES_PER_SESSION = 10;

/** Default `run_process` timeout. A process that runs longer is killed and reported as timed out. */
export const DEFAULT_PROCESS_TIMEOUT_SECONDS = 600;

/**
 * Close a subprocess's stdin sink at teardown so the OS pipe fd is released
 * deterministically rather than left for incidental GC. Mirrors the
 * discipline `.claude/rules/elevation-helpers.md`'s "feeding-consumer
 * teardown obligation" documents for `spawnAsUser` consumers that feed stdin
 * over the process's lifetime -- the same unsound GC-reliance pattern
 * previously flagged as unacceptable for PTY master-fd handles. Tolerates:
 * no sink, an already-exited child (broken pipe on `end()`), and being
 * invoked more than once for the same sink.
 */
function endStdinSafely(stdin: FileSink | null): void {
  if (!stdin) return;
  try {
    stdin.end();
  } catch (err) {
    logger.warn({ err }, 'Failed to close subprocess stdin sink at teardown');
  }
}

interface StoredProcess {
  info: InteractiveProcessInfo;
  subprocess: Subprocess<'pipe', 'pipe', 'pipe'>;
  stdin: FileSink;
  /** True when the child leads its own process group (direct branch). */
  ownsProcessGroup: boolean;
  /**
   * True when the elevated child's leader owns a process group the server
   * cannot signal itself (elevated branch); see `elevatedPgid`.
   */
  elevatedGroup: boolean;
  /** OS user the child runs as (null = the server user), for elevated group signals. */
  username: string | null;
  /**
   * Group id of the elevated leader, discovered eagerly at spawn (the wrapper
   * must still be alive for the discovery to work) and cached. Resolves to
   * null when discovery did not find a qualifying leader.
   */
  elevatedPgid?: Promise<number | null>;
  /** True once `elevatedPgid` has resolved (to a pgid or to null). */
  elevatedPgidSettled: boolean;
  /** True once the held wrapper process has exited; ends the discovery retries. */
  wrapperExited: boolean;
  /** Resolves when both stdout and stderr have been fully read and flushed. */
  streamsDone: Promise<void>;
  /** The single per-process timeout timer; cleared on every teardown path. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Open while output is held for an inline result; undefined once released or settled. */
  inlineWindow?: InlineWindow;
  /** Settles with the inline result, or null when the process did not finish inside the window. */
  inlineResult: Promise<InlineProcessResult | InlineProcessRemoved | null>;
}

/**
 * A process that exited inside its inline window: the whole captured output
 * and the exit code, handed to the caller instead of being routed as turns.
 */
export interface InlineProcessResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Outcome of `awaitInline` when the process was removed (killed, or its session
 * was deleted) while the window was open: removal suppresses the exit
 * callback, so nothing further will ever arrive for it.
 */
export interface InlineProcessRemoved {
  removed: true;
}

const INLINE_PROCESS_REMOVED: InlineProcessRemoved = { removed: true };

/** The open inline window of one process: output is held, not routed. */
interface InlineWindow {
  held: string;
  heldBytes: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (result: InlineProcessResult | InlineProcessRemoved | null) => void;
}

export interface ProcessOutputCallback {
  (process: InteractiveProcessInfo, output: string): void;
}

export interface ProcessExitCallback {
  (process: InteractiveProcessInfo): void;
}

/**
 * Invoked after `writeResponse` successfully forwards content to the
 * subprocess stdin. Consumers route the content based on
 * `process.outputMode` (e.g., echo to PTY, or write a message file).
 *
 * May return a Promise — `writeResponse` awaits it before reporting
 * success so failures in `"message"` mode routing surface to the caller
 * instead of being silently swallowed.
 */
export interface ProcessResponseCallback {
  (process: InteractiveProcessInfo, content: string): void | Promise<void>;
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

  /**
   * How long `runProcess` holds a new process's output waiting for it to
   * exit, so a short command can return its result to the caller instead of
   * arriving later as turns. Callers that never read the result must pass
   * `inlineWindowMs: 0`, otherwise their output is delayed by up to this long.
   */
  static readonly INLINE_RESULT_WINDOW_MS = 5000;

  /**
   * After a timeout kill, how long the exit handler waits for the output
   * streams to drain. The kill hits the shell; a grandchild (`sh -c 'sleep 30'`
   * without exec) can keep the pipes open, and the timeout notice must not
   * wait on it.
   */
  static readonly TIMEOUT_STREAM_DRAIN_GRACE_MS = 1000;

  /** Discovery attempts / spacing for the elevated leader's group id. */
  static readonly ELEVATED_PGID_ATTEMPTS = 20;
  static readonly ELEVATED_PGID_RETRY_MS = 100;

  private processes = new Map<string, StoredProcess>();
  private outputBuffers = new Map<string, OutputBuffer>();
  private onOutput: ProcessOutputCallback;
  private onExit: ProcessExitCallback;
  private ptyMessageInjector?: PtyMessageInjector;
  private onResponse?: ProcessResponseCallback;
  /**
   * Long-lived elevated-spawn helper. Routes the underlying `Bun.spawn`
   * through `sudo -u <user> -i sh -c ...` when the requesting user differs
   * from the server process user under `AUTH_MODE=multi-user`. Injected for
   * testability; defaults to the production import.
   */
  private spawnAsUserFn: SpawnAsUserFn;
  /** Origin the child dials back to, for its `AGENT_CONSOLE_BASE_URL` record. */
  private getBaseUrl: () => string;
  /** Elevated-exec seam for the process-group discovery / signal helpers. */
  private runAsUserImpl: typeof runAsUser;
  /** Inline window applied to a `runProcess` call that does not pass its own. */
  readonly inlineWindowMs: number;

  constructor(
    onOutput: ProcessOutputCallback,
    onExit: ProcessExitCallback,
    ptyMessageInjector?: PtyMessageInjector,
    onResponse?: ProcessResponseCallback,
    spawnAsUserFn: SpawnAsUserFn = spawnAsUser,
    getBaseUrl: () => string = () => `http://localhost:${serverConfig.PORT}`,
    runAsUserImpl: typeof runAsUser = runAsUser,
    inlineWindowMs: number = InteractiveProcessManager.INLINE_RESULT_WINDOW_MS,
  ) {
    this.inlineWindowMs = inlineWindowMs;
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.ptyMessageInjector = ptyMessageInjector;
    this.onResponse = onResponse;
    this.spawnAsUserFn = spawnAsUserFn;
    this.getBaseUrl = getBaseUrl;
    this.runAsUserImpl = runAsUserImpl;
  }

  async runProcess(params: {
    sessionId: string;
    workerId: string;
    command: string;
    cwd?: string;
    outputMode?: InteractiveProcessOutputMode;
    /**
     * OS username to run the command as. Treated identically when
     * `null` / `undefined` -- no elevation. When set under
     * `AUTH_MODE=multi-user` and differing from the server process user,
     * the underlying spawn is elevated via `sudo`. Plumbed in by the
     * `run_process` MCP tool, which resolves it from the calling
     * session's `createdBy`.
     */
    requestUser?: string | null;
    /**
     * Seconds after which a still-running process is killed and reported
     * through the normal exit notification with `timedOut: true`. Defaults to
     * `DEFAULT_PROCESS_TIMEOUT_SECONDS`.
     */
    timeoutSeconds?: number;
    /**
     * Inline window in milliseconds (default: the manager's `inlineWindowMs`,
     * `INLINE_RESULT_WINDOW_MS` unless constructed otherwise; 0 = none). While it is open output is held and neither `onOutput` nor
     * `onExit` is called; read the outcome with `awaitInline`. The window is
     * clamped below the timeout, so a process the timeout kills is never an
     * inline result.
     */
    inlineWindowMs?: number;
  }): Promise<InteractiveProcessInfo> {
    const { sessionId, workerId, command, cwd, requestUser } = params;
    const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_PROCESS_TIMEOUT_SECONDS;
    const outputMode: InteractiveProcessOutputMode = params.outputMode ?? 'pty';

    const sessionProcessCount = this.listProcesses(sessionId).filter(
      (p) => p.status === 'running',
    ).length;
    if (sessionProcessCount >= MAX_PROCESSES_PER_SESSION) {
      throw new Error(
        `Session ${sessionId} already has ${sessionProcessCount} running processes (max ${MAX_PROCESSES_PER_SESSION})`,
      );
    }

    const id = crypto.randomUUID();
    const inlineMs = Math.min(
      params.inlineWindowMs ?? this.inlineWindowMs,
      timeoutSeconds * 1000 - 1,
    );
    let inlineWindow: InlineWindow | undefined;
    let inlineResult: Promise<InlineProcessResult | InlineProcessRemoved | null> = Promise.resolve(null);
    if (inlineMs > 0) {
      inlineResult = new Promise((settle) => {
        inlineWindow = {
          held: '',
          heldBytes: 0,
          timer: setTimeout(() => {
            const open = this.processes.get(id);
            if (open) this.releaseHeldOutput(open);
          }, inlineMs),
          settle,
        };
      });
    }
    const info: InteractiveProcessInfo = {
      id,
      sessionId,
      workerId,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      outputMode,
      timeoutSeconds,
    };

    // Route the spawn through `spawnAsUser` so multi-user mode elevates the
    // child to the requesting user. When `requestUser` is null/undefined or
    // `AUTH_MODE !== 'multi-user'`, the helper bypasses elevation and spawns
    // `sh -c command` directly -- byte-identical to the prior raw
    // `Bun.spawn(['sh', '-c', command], { ... })` invocation.
    const { subprocess, stdin, ownsProcessGroup, elevatedGroup } = this.spawnAsUserFn({
      username: requestUser ?? null,
      command,
      cwd,
      // Identity records only (BASE_URL / SESSION_ID / WORKER_ID): every
      // descendant of the child inherits AGENT_CONSOLE_SESSION_ID, which is
      // what the orphan-process sweep matches on. Nothing else about the
      // child's environment changes.
      env: buildAgentConsoleEnv({ baseUrl: this.getBaseUrl(), sessionId, workerId }),
      newProcessGroup: true,
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
      stdin,
      ownsProcessGroup: ownsProcessGroup === true,
      elevatedGroup: elevatedGroup === true,
      username: requestUser ?? null,
      elevatedPgidSettled: false,
      wrapperExited: false,
      streamsDone,
      inlineWindow,
      inlineResult,
    };
    this.processes.set(id, stored);
    if (stored.elevatedGroup) {
      subprocess.exited.then(
        () => {
          stored.wrapperExited = true;
        },
        () => {
          stored.wrapperExited = true;
        },
      );
      stored.elevatedPgid = this.discoverElevatedGroup(stored).finally(() => {
        stored.elevatedPgidSettled = true;
      });
    }

    // On expiry, signal the child but leave the entry in place: the
    // `subprocess.exited` handler below is the single route that fires
    // `onExit`, so the timeout notice travels the same path as a natural exit.
    // SIGKILL (not SIGTERM): a child that ignores SIGTERM would defeat the
    // guarantee this timeout exists to give: a process past its timeout is
    // always ended and reported.
    stored.timeoutTimer = setTimeout(() => {
      const current = this.processes.get(id);
      if (!current || current.info.status !== 'running') return;
      logger.warn({ processId: id, sessionId, timeoutSeconds }, 'Process timed out, killing');
      current.info.timedOut = true;
      try {
        this.signalStored(current, 9);
      } catch {
        // Process may have already exited
      }
      endStdinSafely(current.stdin);
    }, timeoutSeconds * 1000);

    // Monitor process exit — wait for streams to be fully read before calling onExit.
    // This prevents the race where subprocess.exited resolves before readStream
    // finishes flushing output, which would cause the delayed \r from
    // writePtyNotification (sent by onOutput) to arrive after the exit notification.
    subprocess.exited.then(async (exitCode) => {
      const current = this.processes.get(id);
      if (current) {
        clearTimeout(current.timeoutTimer);
        if (current.info.timedOut) {
          await Promise.race([
            current.streamsDone,
            new Promise<void>((resolve) => setTimeout(resolve, InteractiveProcessManager.TIMEOUT_STREAM_DRAIN_GRACE_MS)),
          ]);
        } else {
          await current.streamsDone;
        }
        current.info.status = 'exited';
        current.info.exitCode = exitCode;
        logger.info({ processId: id, exitCode }, 'Process exited');
        const heldWindow = current.inlineWindow;
        if (heldWindow) {
          // Exited with its streams drained inside the window: the caller gets
          // the output and the code, and nothing is routed as a turn.
          this.closeInlineWindow(current, {
            output: heldWindow.held,
            exitCode,
            timedOut: current.info.timedOut === true,
          });
        } else {
          this.onExit({ ...current.info });
        }
        // A timed-out process is gone once reported; a naturally exited one
        // stays listed with status 'exited' as before.
        if (current.info.timedOut) {
          this.processes.delete(id);
        }
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

  /**
   * Resolves with the captured result when the process exited and its streams
   * drained inside the inline window; `{ removed: true }` when it was removed
   * while the window was open (nothing will arrive for it); null when the
   * window ended first -- by expiry or by the hold cap, in which case the held
   * output has been routed and more follows -- or there was none, or the
   * process is unknown. Never rejects.
   */
  awaitInline(processId: string): Promise<InlineProcessResult | InlineProcessRemoved | null> {
    return this.processes.get(processId)?.inlineResult ?? Promise.resolve(null);
  }

  private closeInlineWindow(
    stored: StoredProcess,
    result: InlineProcessResult | InlineProcessRemoved | null,
  ): void {
    const window = stored.inlineWindow;
    if (!window) return;
    stored.inlineWindow = undefined;
    clearTimeout(window.timer);
    window.settle(result);
  }

  /** End the hold without a result: flush the held text once through `onOutput` and route normally from here. */
  private releaseHeldOutput(stored: StoredProcess): void {
    const held = stored.inlineWindow?.held ?? '';
    this.closeInlineWindow(stored, null);
    if (held) {
      this.onOutput({ ...stored.info }, held);
    }
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
      // In `pty` mode, echo response content to the worker PTY (newlines
      // normalized to LF so they remain soft newlines, no Enter yet). The
      // Enter (\r) will be sent by writePtyNotification when process output
      // settles and onOutput is called. Converting \n to \r here previously
      // caused multi-line responses to be submitted as multiple messages.
      // In `message` mode the brief PTY notification is
      // emitted by the onResponse consumer, so PTY echo is skipped here.
      if (this.ptyMessageInjector && stored.info.outputMode === 'pty') {
        this.ptyMessageInjector.writePtyData(
          stored.info.sessionId,
          stored.info.workerId,
          content.replace(/\r?\n/g, '\n'),
        );
      }

      // Write content followed by null byte (\0) to unblock the script's stdin reader.
      // Process output will arrive via readStream → bufferOutput → debounce →
      // flush → onOutput → writePtyNotification → \r
      stored.stdin.write(content + '\0');
      stored.stdin.flush();

      logger.debug({ processId, contentLength: content.length }, 'Wrote response to process');
    } catch (err) {
      logger.warn({ processId, err }, 'Failed to write to process stdin');
      return false;
    }

    // Notify the consumer that a response was forwarded. Routing per
    // outputMode (PTY echo vs message file) is the consumer's concern.
    // The callback is awaited so message-mode routing failures (e.g., disk
    // write error, resolver miss) surface as a `false` return to the
    // caller instead of being silently swallowed.
    if (this.onResponse) {
      try {
        await this.onResponse({ ...stored.info }, content);
      } catch (err) {
        logger.warn({ processId, err }, 'onResponse callback failed');
        return false;
      }
    }

    return true;
  }

  killProcess(processId: string): boolean {
    const stored = this.processes.get(processId);
    if (!stored) {
      return false;
    }

    this.clearOutputBuffer(processId);
    this.closeInlineWindow(stored, INLINE_PROCESS_REMOVED);
    clearTimeout(stored.timeoutTimer);

    try {
      this.signalStored(stored, 15); // SIGTERM
    } catch {
      // Process may have already exited
    }
    endStdinSafely(stored.stdin);

    stored.info.status = 'exited';
    this.processes.delete(processId);
    logger.info({ processId }, 'Process killed');
    return true;
  }

  /**
   * Signal the child. When it leads its own process group, signal the group
   * so descendants (`sh -c 'sleep 30 & wait'`) die with the shell; otherwise
   * fall back to the shell alone. The group is only signalled while the entry
   * is still running: once the shell has exited its pid (and so the group id)
   * may be reused by an unrelated process, and a group signal would hit it.
   *
   * Direct branch: a negative-pid `process.kill`. Elevated branch: the group
   * belongs to the target user, so after the wrapper-pid signal (as before)
   * the group is signalled with an elevated `kill` in the background -- this
   * stays synchronous for the caller.
   */
  private signalStored(stored: StoredProcess, signal: 9 | 15): void {
    const pid = stored.subprocess.pid;
    if (stored.info.status === 'running') {
      if (stored.ownsProcessGroup && typeof pid === 'number' && pid > 0) {
        try {
          process.kill(-pid, signal);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
            logger.warn({ err, pid }, 'Process group signal failed, signalling the shell only');
          }
        }
      } else if (stored.elevatedGroup) {
        if (stored.elevatedPgidSettled) {
          // Group id already known (or known-unavailable): wrapper first, as
          // for every other spawn, then the group in the background.
          stored.subprocess.kill(signal);
          void this.signalElevatedGroup(stored, signal);
        } else {
          // Discovery still in flight: killing the wrapper now would make the
          // group id undiscoverable, so signal the group first and the
          // wrapper after it. The caller stays synchronous either way.
          void this.signalElevatedGroup(stored, signal).finally(() => {
            try {
              stored.subprocess.kill(signal);
            } catch {
              // Process may have already exited
            }
          });
        }
        return;
      }
    }
    stored.subprocess.kill(signal);
  }

  /**
   * Find the elevated leader's group id, retrying briefly: the leader only
   * exists once the elevated login shell has run the wrapped `setsid`.
   */
  private async discoverElevatedGroup(stored: StoredProcess): Promise<number | null> {
    const pid = stored.subprocess.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    for (let attempt = 0; attempt < InteractiveProcessManager.ELEVATED_PGID_ATTEMPTS; attempt++) {
      if (stored.wrapperExited) return null;
      try {
        const pgid = await discoverElevatedPgid(pid, stored.username, {
          runAsUserImpl: this.runAsUserImpl,
        });
        if (pgid !== null) return pgid;
      } catch (err) {
        logger.warn({ processId: stored.info.id, err }, 'Elevated process group discovery failed');
        return null;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, InteractiveProcessManager.ELEVATED_PGID_RETRY_MS),
      );
    }
    return null;
  }

  private async signalElevatedGroup(stored: StoredProcess, signal: 9 | 15): Promise<void> {
    try {
      const pgid = await stored.elevatedPgid;
      if (pgid === null || pgid === undefined) {
        logger.warn(
          { processId: stored.info.id },
          'No elevated process group id known; only the wrapper was signalled, descendants may survive until the next orphan sweep',
        );
        return;
      }
      const result = await killProcessGroupAsUser(pgid, signal === 9 ? 'SIGKILL' : 'SIGTERM', stored.username, {
        runAsUserImpl: this.runAsUserImpl,
      });
      if (result.timedOut || result.exitCode !== 0) {
        logger.debug(
          { processId: stored.info.id, pgid, exitCode: result.exitCode, timedOut: result.timedOut },
          'Elevated process group signal reported non-success (the group may already be gone)',
        );
      }
    } catch (err) {
      logger.warn({ processId: stored.info.id, err }, 'Elevated process group signal failed');
    }
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
        this.closeInlineWindow(stored, INLINE_PROCESS_REMOVED);
        clearTimeout(stored.timeoutTimer);
        try {
          this.signalStored(stored, 15);
        } catch {
          // Process may have already exited
        }
        endStdinSafely(stored.stdin);
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
      this.closeInlineWindow(stored, INLINE_PROCESS_REMOVED);
      clearTimeout(stored.timeoutTimer);
      try {
        this.signalStored(stored, 15);
      } catch {
        // Process may have already exited
      }
      endStdinSafely(stored.stdin);
    }
    const count = this.processes.size;
    this.processes.clear();
    logger.info({ count }, 'All processes disposed');
  }

  private bufferOutput(processId: string, text: string): void {
    const stored = this.processes.get(processId);
    const window = stored?.inlineWindow;
    if (stored && window) {
      window.held += text;
      window.heldBytes += Buffer.byteLength(text);
      // A chatty process must not pin memory for the whole window.
      if (window.heldBytes > MESSAGE_CHUNK_TARGET_BYTES) {
        this.releaseHeldOutput(stored);
      }
      return;
    }
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
