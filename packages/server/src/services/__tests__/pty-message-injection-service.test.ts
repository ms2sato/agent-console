import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { PtyMessageInjectionService } from '../pty-message-injection-service.js';

// Bracketed paste delimiters (DEC private mode 2004) — see Issue #792.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const wrap = (s: string) => `${PASTE_START}${s}${PASTE_END}`;

describe('PtyMessageInjectionService', () => {
  let writeInput: ReturnType<typeof mock>;
  let isWorkerActive: ReturnType<typeof mock>;
  let service: PtyMessageInjectionService;

  beforeEach(() => {
    jest.useFakeTimers();
    writeInput = mock(() => true);
    isWorkerActive = mock(() => true);
    service = new PtyMessageInjectionService(
      writeInput as (sessionId: string, workerId: string, data: string) => boolean,
      isWorkerActive as (sessionId: string, workerId: string) => boolean,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should inject single content part wrapped in bracketed paste and queue unwrapped final Enter', () => {
    const result = service.injectMessage('s1', 'w1', 'hello world');

    expect(result).toBe(true);
    // First part written immediately, wrapped in bracketed paste delimiters
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('hello world'));
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Final Enter queued with delay — NOT wrapped (submit keystroke)
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r');
    expect(writeInput).toHaveBeenCalledTimes(2);
  });

  it('should preserve LF newlines inside the bracketed paste envelope (Issue #660 + #792)', () => {
    const result = service.injectMessage('s1', 'w1', 'line1\nline2\nline3');

    expect(result).toBe(true);
    // Newlines stay inside the envelope as literal text, single write, not split
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('line1\nline2\nline3'));
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Exactly one final \r submit
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenLastCalledWith('s1', 'w1', '\r');
    expect(writeInput).toHaveBeenCalledTimes(2);
  });

  it('should normalize CRLF to LF inside the bracketed paste envelope', () => {
    service.injectMessage('s1', 'w1', 'line1\r\nline2\r\nline3');
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('line1\nline2\nline3'));
  });

  it('preserves multiple consecutive newlines inside the envelope (Issue #660 regression)', () => {
    // Regression test: previously \n was converted to \r (submit), so 3 blank
    // lines split a single message into 3 separate submissions to the agent.
    const result = service.injectMessage('s1', 'w1', 'First line\n\n\nSecond line');

    expect(result).toBe(true);
    // Newlines preserved verbatim inside a single wrapped write.
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('First line\n\n\nSecond line'));
    // Only ONE write before any timer advances — body is not split.
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Exactly one final \r submit is queued (no premature submits inside body).
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledTimes(2);
    expect(writeInput).toHaveBeenLastCalledWith('s1', 'w1', '\r');

    // No further writes after the single submit.
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS * 5);
    expect(writeInput).toHaveBeenCalledTimes(2);
  });

  it('should inject content followed by file paths with delays, each part wrapped', () => {
    const result = service.injectMessage('s1', 'w1', 'check these', ['/tmp/a.txt', '/tmp/b.txt']);

    expect(result).toBe(true);
    // Immediate: content wrapped
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('check these'));
    expect(writeInput).toHaveBeenCalledTimes(1);

    // After 150ms: first file — leading \r (submit of prev part) unwrapped, content wrapped
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', `\r${wrap('/tmp/a.txt')}`);
    expect(writeInput).toHaveBeenCalledTimes(2);

    // After 300ms: second file
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', `\r${wrap('/tmp/b.txt')}`);
    expect(writeInput).toHaveBeenCalledTimes(3);

    // After 450ms: final Enter — unwrapped
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r');
    expect(writeInput).toHaveBeenCalledTimes(4);
  });

  it('should inject files only (wrapped) when content is empty', () => {
    const result = service.injectMessage('s1', 'w1', '', ['/tmp/file.txt']);

    expect(result).toBe(true);
    // First file written immediately, wrapped
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('/tmp/file.txt'));
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Final Enter after delay — unwrapped
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r');
    expect(writeInput).toHaveBeenCalledTimes(2);
  });

  it('should return false when content and filePaths are both empty', () => {
    const result = service.injectMessage('s1', 'w1', '');
    expect(result).toBe(false);
    expect(writeInput).not.toHaveBeenCalled();
  });

  it('should return false when content is empty and filePaths is empty array', () => {
    const result = service.injectMessage('s1', 'w1', '', []);
    expect(result).toBe(false);
    expect(writeInput).not.toHaveBeenCalled();
  });

  it('should return false when writer returns false (PTY inactive)', () => {
    writeInput = mock(() => false);
    service = new PtyMessageInjectionService(
      writeInput as (sessionId: string, workerId: string, data: string) => boolean,
      isWorkerActive as (sessionId: string, workerId: string) => boolean,
    );

    const result = service.injectMessage('s1', 'w1', 'hello');
    expect(result).toBe(false);
    expect(writeInput).toHaveBeenCalledTimes(1);
  });

  it('should skip delayed writes when worker becomes inactive', () => {
    let active = true;
    isWorkerActive = mock(() => active);
    service = new PtyMessageInjectionService(
      writeInput as (sessionId: string, workerId: string, data: string) => boolean,
      isWorkerActive as (sessionId: string, workerId: string) => boolean,
    );

    service.injectMessage('s1', 'w1', 'check', ['/tmp/a.txt']);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', wrap('check'));
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Worker becomes inactive before delayed writes fire
    active = false;

    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS * 3);

    // No additional writes after the first immediate one
    expect(writeInput).toHaveBeenCalledTimes(1);
    // isWorkerActive was checked for each delayed callback
    expect(isWorkerActive).toHaveBeenCalledWith('s1', 'w1');
  });
});
