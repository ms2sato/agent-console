import type { WSContext } from 'hono/ws';
import type { WorkerServerMessage } from '@agent-console/shared';
import { WS_READY_STATE } from '@agent-console/shared';
import type pino from 'pino';

/**
 * Encapsulates WebSocket output buffering logic for worker connections.
 *
 * Buffers rapid PTY output messages and flushes them at intervals to reduce
 * WebSocket message frequency. Handles ordering guarantees: non-output messages
 * (exit, activity, etc.) always flush pending output first to preserve ordering.
 *
 * On send failure or when the socket is not OPEN, buffered data is discarded.
 * This is safe because the data is preserved in server-side worker history
 * (in-memory outputBuffer and file-based workerOutputFileManager), and the
 * client can recover it via history request on reconnect.
 */
export class BufferedWebSocketSender {
  private outputBuffer = '';
  private outputBufferBytes = 0;
  private lastOffset = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly ws: WSContext,
    private readonly getReadyState: () => number | undefined,
    private readonly logger: pino.Logger,
    private readonly workerId: string,
    private readonly flushInterval: number = 50,
    private readonly flushThreshold: number = 64 * 1024,
  ) {}

  /**
   * Send a message through the WebSocket.
   *
   * Output messages are buffered and flushed at intervals.
   * Non-output messages flush pending output first (ordering guarantee),
   * then are sent immediately.
   */
  send(msg: WorkerServerMessage): void {
    if (this.disposed) {
      return;
    }

    if (msg.type === 'output') {
      this.bufferOutput(msg.data, msg.offset);
    } else {
      // Flush pending output before non-output messages to preserve ordering
      this.flush();
      this.sendImmediate(msg);
    }
  }

  /**
   * Flush any buffered output to the WebSocket.
   *
   * Checks readyState before sending. If the socket is not OPEN,
   * the buffer is discarded (data is preserved server-side for recovery).
   * On send failure, the buffer is also discarded for the same reason.
   */
  flush(): void {
    if (this.disposed) {
      return;
    }

    this.clearFlushTimer();

    if (this.outputBuffer.length === 0) {
      return;
    }

    const readyState = this.getReadyState();
    // When readyState is undefined (Hono adapter doesn't expose it), fall through
    // and rely on try/catch as safety net. This matches the pre-existing behavior.
    if (readyState !== undefined && readyState !== WS_READY_STATE.OPEN) {
      // Socket is not open; discard buffer (data preserved server-side)
      this.outputBuffer = '';
      this.outputBufferBytes = 0;
      return;
    }

    try {
      this.ws.send(JSON.stringify({ type: 'output', data: this.outputBuffer, offset: this.lastOffset }));
      this.outputBuffer = '';
      this.outputBufferBytes = 0;
    } catch (error) {
      this.logger.warn({ workerId: this.workerId, err: error }, 'Error flushing output buffer to worker');
      // Discard buffer on failure (data preserved server-side for recovery)
      this.outputBuffer = '';
      this.outputBufferBytes = 0;
    }
  }

  /**
   * Dispose this sender. Clears the flush timer, discards the buffer,
   * and marks as disposed so all future operations become no-ops.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearFlushTimer();
    this.outputBuffer = '';
    this.outputBufferBytes = 0;
  }

  /** Whether this sender has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Buffer output data for batched sending.
   *
   * Each `offset` must represent the cumulative byte count of all PTY output
   * delivered so far (i.e., the end-byte position after this chunk). This is
   * the same semantic used by the old inline code and matches how
   * worker.outputOffset is computed in worker-manager.ts.
   */
  private bufferOutput(data: string, offset: number): void {
    this.outputBuffer += data;
    this.outputBufferBytes += Buffer.byteLength(data, 'utf-8');
    this.lastOffset = offset;

    // Flush immediately if buffer exceeds threshold (prevents unbounded memory growth)
    if (this.outputBufferBytes >= this.flushThreshold) {
      this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  private sendImmediate(msg: WorkerServerMessage): void {
    const readyState = this.getReadyState();
    // When readyState is undefined (Hono adapter doesn't expose it), fall through
    // and rely on try/catch as safety net. This matches the pre-existing behavior.
    if (readyState !== undefined && readyState !== WS_READY_STATE.OPEN) {
      return;
    }

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (error) {
      this.logger.warn({ workerId: this.workerId, err: error }, 'Error sending message to worker');
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
