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
      kind: 'inbound-event',
      tag: 'inbound:ci:failed',
      fields: { type: 'ci:failed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'Build failed' },
      intent: 'triage',
      writeInput,
    });

    // Timestamp is dynamic, so verify structure rather than exact match
    expect(result).toMatch(/^\n\[inbound:ci:failed\] timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(result).toContain('type=ci:failed');
    expect(result).toContain('source=github');
    expect(result).toContain('repo=owner/repo');
    expect(result).toContain('branch=main');
    expect(result).toContain('url=https://example.com');
    expect(result).toContain('summary="Build failed"');
    expect(result).toContain('intent=triage');
    expect(written[0]).toBe(result);
  });

  it('returns the notification string without trailing carriage return', () => {
    const result = writePtyNotification({
      kind: 'inbound-event',
      tag: 'inbound:ci:completed',
      fields: { type: 'ci:completed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'CI passed' },
      intent: 'inform',
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
        kind: 'internal-message',
        tag: 'internal:message',
        fields: { source: 'session', from: 'sender-1', summary: 'Test message', path: '/tmp/msg' },
        intent: 'triage',
        writeInput,
      });

      // Before the timer fires, only the notification text should be written
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('[internal:message]');

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
      kind: 'internal-message',
      tag: 'internal:message',
      fields: { source: 'session', from: 'sender-1', summary: 'hello world', path: '/tmp/simple' },
      intent: 'inform',
      writeInput: (data) => { written.push(data); },
    });

    // 'hello world' has a space, so it should be quoted
    expect(written[0]).toContain('summary="hello world"');
    // '/tmp/simple' has no special chars requiring quoting (slash and alphanumeric)
    expect(written[0]).toContain('path=/tmp/simple');
  });

  it('includes intent field in notification output', () => {
    const written: string[] = [];

    writePtyNotification({
      kind: 'inbound-event',
      tag: 'inbound:ci:completed',
      fields: { type: 'ci:completed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'CI passed' },
      intent: 'inform',
      writeInput: (data) => { written.push(data); },
    });

    expect(written[0]).toContain('intent=inform');
  });

  it('includes timestamp in ISO 8601 format for inbound-event notifications', () => {
    const written: string[] = [];

    writePtyNotification({
      kind: 'inbound-event',
      tag: 'inbound:ci:failed',
      fields: { type: 'ci:failed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'Build failed' },
      intent: 'triage',
      writeInput: (data) => { written.push(data); },
    });

    expect(written[0]).toMatch(/timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('includes timestamp in ISO 8601 format for internal-message notifications', () => {
    const written: string[] = [];

    writePtyNotification({
      kind: 'internal-message',
      tag: 'internal:message',
      fields: { source: 'session', from: 'sender-1', summary: 'Test message', path: '/tmp/msg' },
      intent: 'inform',
      writeInput: (data) => { written.push(data); },
    });

    expect(written[0]).toMatch(/timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('includes timestamp in ISO 8601 format for internal-timer notifications', () => {
    const written: string[] = [];

    writePtyNotification({
      kind: 'internal-timer',
      tag: 'internal:timer',
      fields: { timerId: 'timer-1', action: 'check', fireCount: '1' },
      intent: 'inform',
      writeInput: (data) => { written.push(data); },
    });

    expect(written[0]).toMatch(/timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('places timestamp as the first field in the notification', () => {
    const written: string[] = [];

    writePtyNotification({
      kind: 'internal-timer',
      tag: 'internal:timer',
      fields: { timerId: 'timer-1', action: 'check', fireCount: '1' },
      intent: 'inform',
      writeInput: (data) => { written.push(data); },
    });

    // After the tag, timestamp should be the first key=value pair
    expect(written[0]).toMatch(/^\n\[internal:timer\] timestamp=/);
  });
});
