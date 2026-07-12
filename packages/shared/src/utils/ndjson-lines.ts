/**
 * Incremental newline-delimited (NDJSON) line splitter.
 *
 * Feeds arbitrary string chunks and extracts complete lines (delimited by
 * `\n`, with a trailing `\r` stripped) while buffering the incomplete trailing
 * line as `carry` across pushes. Used by the embedded-agent loop (stdin reader),
 * the server (stdout reader), and the client (replayed-history reader).
 *
 * Byte lengths are measured with TextEncoder and tracked INCREMENTALLY: each
 * chunk's bytes are encoded once, never the whole accumulated carry, so a
 * pathological newline-free stream stays O(n) overall.
 */

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

export interface NdjsonPushResult {
  /**
   * Complete lines extracted from the buffered stream (without trailing
   * newline; a trailing '\r' is stripped). May include empty strings — callers
   * decide whether to skip them.
   */
  lines: string[];
  /**
   * True when maxLineBytes is configured and either a completed line or the
   * pending carry exceeded it. The splitter does not recover; the consumer must
   * treat the stream as corrupt.
   */
  oversized: boolean;
}

export class NdjsonLineSplitter {
  private readonly maxLineBytes: number | undefined;
  private buffer = '';
  private bufferBytes = 0;

  constructor(opts?: { maxLineBytes?: number }) {
    this.maxLineBytes = opts?.maxLineBytes;
  }

  push(chunk: string): NdjsonPushResult {
    const lines: string[] = [];
    let oversized = false;

    const parts = chunk.split('\n');
    // Every part except the last is terminated by a `\n` in the stream, so it
    // completes a line. The last part is the new incomplete carry.
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      const lineBytes = this.bufferBytes + byteLength(segment);
      if (this.maxLineBytes !== undefined && lineBytes > this.maxLineBytes) {
        oversized = true;
      }
      const line = this.buffer + segment;
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      this.buffer = '';
      this.bufferBytes = 0;
    }

    const last = parts[parts.length - 1];
    if (last.length > 0) {
      this.buffer += last;
      this.bufferBytes += byteLength(last);
    }
    if (this.maxLineBytes !== undefined && this.bufferBytes > this.maxLineBytes) {
      oversized = true;
    }

    return { lines, oversized };
  }

  /** The incomplete trailing line buffered so far. */
  get carry(): string {
    return this.buffer;
  }
}
