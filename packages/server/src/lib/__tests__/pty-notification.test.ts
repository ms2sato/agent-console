import { describe, expect, it, jest, mock } from 'bun:test';
import { formatFieldValue, writePtyNotification } from '../pty-notification.js';

describe('formatFieldValue', () => {
  it('returns simple value as-is', () => {
    expect(formatFieldValue('hello')).toBe('hello');
  });

  it('quotes values containing spaces', () => {
    expect(formatFieldValue('hello world')).toBe('"hello world"');
  });

  it('quotes values containing equals sign', () => {
    expect(formatFieldValue('key=value')).toBe('"key=value"');
  });

  it('escapes double quotes and wraps in quotes', () => {
    expect(formatFieldValue('say "hello"')).toBe('"say \\"hello\\""');
  });

  it('collapses whitespace into single spaces', () => {
    expect(formatFieldValue('hello\n  world\ttab')).toBe('"hello world tab"');
  });

  it('trims leading and trailing whitespace', () => {
    expect(formatFieldValue('  hello  ')).toBe('hello');
  });

  // Control character sanitization tests
  it('strips null bytes', () => {
    expect(formatFieldValue('hello\x00world')).toBe('helloworld');
  });

  it('strips ESC sequences', () => {
    // After stripping \x1b, result is 'hello[31mred[0m' (no spaces/equals, so unquoted)
    expect(formatFieldValue('hello\x1b[31mred\x1b[0m')).toBe('hello[31mred[0m');
  });

  it('strips bell character', () => {
    expect(formatFieldValue('hello\x07world')).toBe('helloworld');
  });

  it('strips backspace character', () => {
    expect(formatFieldValue('hello\x08world')).toBe('helloworld');
  });

  it('strips DEL character (0x7f)', () => {
    expect(formatFieldValue('hello\x7fworld')).toBe('helloworld');
  });

  it('strips mixed control characters from realistic input', () => {
    // Simulates a malicious PR title with terminal escape injection
    // After stripping \x1b, \x07, \x00: '[2J[HCI passed' (has space, so quoted)
    const malicious = '\x1b[2J\x1b[HCI passed\x07\x00';
    expect(formatFieldValue(malicious)).toBe('"[2J[HCI passed"');
  });

  it('preserves whitespace characters for normalization (tab, newline, CR)', () => {
    // Tab, newline, CR should be collapsed to spaces (not stripped)
    expect(formatFieldValue('line1\nline2\ttab\rreturn')).toBe('"line1 line2 tab return"');
  });

  it('handles string with only control characters', () => {
    expect(formatFieldValue('\x00\x01\x07\x1b')).toBe('');
  });

  it('strips Unicode C1 control characters (U+0080-U+009F)', () => {
    // U+009B is the 8-bit CSI (Control Sequence Introducer), equivalent to ESC [
    expect(formatFieldValue('hello\u009B31mworld')).toBe('hello31mworld');
  });

  it('strips mixed C0 and C1 control characters', () => {
    expect(formatFieldValue('\x1b\u0080\u009f\u009Btest')).toBe('test');
  });

  it('handles empty string', () => {
    expect(formatFieldValue('')).toBe('');
  });
});

describe('writePtyNotification', () => {
  it('builds and writes a notification string with the correct format', () => {
    const written: string[] = [];
    const writeInput = mock((data: string) => { written.push(data); });

    const result = writePtyNotification({
      tag: 'inbound:ci:failed',
      fields: { type: 'ci:failed', source: 'github', summary: 'Build failed' },
      writeInput,
    });

    expect(result).toBe('\n[inbound:ci:failed] type=ci:failed source=github summary="Build failed"');
    expect(written[0]).toBe(result);
  });

  it('returns the notification string without trailing carriage return', () => {
    const result = writePtyNotification({
      tag: 'test',
      fields: { key: 'value' },
      writeInput: () => {},
    });

    expect(result.endsWith('\r')).toBe(false);
    expect(result.endsWith('\n')).toBe(false);
  });

  it('sends Enter keystroke separately after a 150ms delay', () => {
    jest.useFakeTimers();
    try {
      const written: string[] = [];
      const writeInput = mock((data: string) => { written.push(data); });

      writePtyNotification({
        tag: 'inbound:message',
        fields: { source: 'session', from: 'sender-1' },
        writeInput,
      });

      // Before the timer fires, only the notification text should be written
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('[inbound:message]');

      // Advance past the 150ms delay
      jest.advanceTimersByTime(150);

      // Now the Enter keystroke should have been sent as a second write
      expect(written).toHaveLength(2);
      expect(written[1]).toBe('\r');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sanitizes field values via formatFieldValue', () => {
    const written: string[] = [];

    writePtyNotification({
      tag: 'test',
      fields: { msg: 'hello world', safe: 'simple' },
      writeInput: (data) => { written.push(data); },
    });

    // 'hello world' has a space, so it should be quoted
    expect(written[0]).toContain('msg="hello world"');
    // 'simple' has no special chars, so it should be unquoted
    expect(written[0]).toContain('safe=simple');
  });
});
