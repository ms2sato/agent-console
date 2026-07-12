import { describe, it, expect } from 'bun:test';
import { SseParser, parseSseLine } from '../sse.js';

describe('parseSseLine', () => {
  it('parses a data line into JSON', () => {
    expect(parseSseLine('data: {"a":1}')).toEqual({ kind: 'data', json: { a: 1 } });
  });

  it('recognizes the [DONE] sentinel', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ kind: 'done' });
  });

  it('ignores comment and non-data lines', () => {
    expect(parseSseLine(': keep-alive')).toEqual({ kind: 'ignore' });
    expect(parseSseLine('event: message')).toEqual({ kind: 'ignore' });
    expect(parseSseLine('')).toEqual({ kind: 'ignore' });
  });

  it('ignores an empty data payload', () => {
    expect(parseSseLine('data: ')).toEqual({ kind: 'ignore' });
  });
});

describe('SseParser', () => {
  it('buffers partial lines across pushes', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    const result = parser.push(':1}\n\n');
    expect(result).toEqual([{ kind: 'data', json: { a: 1 } }, { kind: 'ignore' }]);
  });

  it('parses multiple frames from a single chunk', () => {
    const parser = new SseParser();
    const result = parser.push('data: {"a":1}\ndata: [DONE]\n');
    expect(result).toEqual([{ kind: 'data', json: { a: 1 } }, { kind: 'done' }]);
  });
});
