import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { PtyMessageInjectionService } from '../pty-message-injection-service.js';

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

  it('should inject single content part and queue final Enter', () => {
    const result = service.injectMessage('s1', 'w1', 'hello world');

    expect(result).toBe(true);
    // First part written immediately
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', 'hello world');
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Final Enter queued with delay
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r');
    expect(writeInput).toHaveBeenCalledTimes(2);
  });

  it('should convert newlines to carriage returns in content', () => {
    service.injectMessage('s1', 'w1', 'line1\nline2\nline3');
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', 'line1\rline2\rline3');
  });

  it('should convert CRLF to single CR', () => {
    service.injectMessage('s1', 'w1', 'line1\r\nline2\r\nline3');
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', 'line1\rline2\rline3');
  });

  it('should inject content followed by file paths with delays', () => {
    const result = service.injectMessage('s1', 'w1', 'check these', ['/tmp/a.txt', '/tmp/b.txt']);

    expect(result).toBe(true);
    // Immediate: content
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', 'check these');
    expect(writeInput).toHaveBeenCalledTimes(1);

    // After 150ms: first file
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r/tmp/a.txt');
    expect(writeInput).toHaveBeenCalledTimes(2);

    // After 300ms: second file
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r/tmp/b.txt');
    expect(writeInput).toHaveBeenCalledTimes(3);

    // After 450ms: final Enter
    jest.advanceTimersByTime(PtyMessageInjectionService.DELAY_MS);
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '\r');
    expect(writeInput).toHaveBeenCalledTimes(4);
  });

  it('should inject files only when content is empty', () => {
    const result = service.injectMessage('s1', 'w1', '', ['/tmp/file.txt']);

    expect(result).toBe(true);
    // First file written immediately
    expect(writeInput).toHaveBeenCalledWith('s1', 'w1', '/tmp/file.txt');
    expect(writeInput).toHaveBeenCalledTimes(1);

    // Final Enter after delay
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
