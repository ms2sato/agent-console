/**
 * Minimal Server-Sent Events parser for OpenAI-compatible streaming responses.
 *
 * The transport is `text/event-stream`; each event carries a single `data:`
 * line whose payload is a JSON chunk (or the sentinel `[DONE]`). Partial-chunk
 * carry across network reads is handled by the shared NDJSON line splitter.
 */

import { NdjsonLineSplitter } from '@agent-console/shared';

export type SseLine =
  | { kind: 'data'; json: unknown }
  | { kind: 'done' }
  | { kind: 'ignore' };

const DATA_PREFIX = 'data:';

/** Parse a single already-split SSE line into a typed result. */
export function parseSseLine(line: string): SseLine {
  if (!line.startsWith(DATA_PREFIX)) {
    // Comments (':' lines), event/id fields, and blank frame separators.
    return { kind: 'ignore' };
  }
  const payload = line.slice(DATA_PREFIX.length).trim();
  if (payload.length === 0) {
    return { kind: 'ignore' };
  }
  if (payload === '[DONE]') {
    return { kind: 'done' };
  }
  return { kind: 'data', json: JSON.parse(payload) };
}

/**
 * Stateful SSE parser that buffers partial lines across network reads and emits
 * parsed lines. `push` returns the lines completed by this chunk.
 */
export class SseParser {
  private readonly splitter = new NdjsonLineSplitter();

  push(chunk: string): SseLine[] {
    const { lines } = this.splitter.push(chunk);
    return lines.map(parseSseLine);
  }
}
