import { describe, expect, it, jest, mock, setSystemTime, spyOn } from 'bun:test';
import {
  formatFieldValue,
  stripControlChars,
  writePtyNotification,
  buildPtyNotificationText,
  buildReplyInstructions,
  extractNotificationSummary,
} from '../pty-notification.js';

describe('stripControlChars', () => {
  it('strips a C0-range byte (\\x01)', () => {
    expect(stripControlChars('hello\x01world')).toBe('helloworld');
  });

  it('strips a C0-range byte from the \\x0e-\\x1f sub-range (\\x0e)', () => {
    expect(stripControlChars('hello\x0eworld')).toBe('helloworld');
  });

  it('strips DEL (\\x7f)', () => {
    expect(stripControlChars('hello\x7fworld')).toBe('helloworld');
  });

  it('strips a C1-range byte (\\x9b)', () => {
    expect(stripControlChars('hello\x9bworld')).toBe('helloworld');
  });

  it('preserves tab, newline, and carriage return', () => {
    expect(stripControlChars('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('preserves ordinary text unchanged', () => {
    expect(stripControlChars('hello world 123')).toBe('hello world 123');
  });

  it('agrees with formatFieldValue\'s strip step: stripping first then formatting equals formatting directly', () => {
    const fixture = 'a\x01b\x0ec\x7fd\x9be';
    expect(formatFieldValue(fixture)).toBe(formatFieldValue(stripControlChars(fixture)));
  });
});

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
    const writeInput = mock((data: string) => { written.push(data); return true; });

    const result = writePtyNotification({
      kind: 'inbound-event',
      tag: 'inbound:ci:failed',
      fields: { type: 'ci:failed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'Build failed' },
      intent: 'triage',
      writeInput,
    });

    // Timestamp is dynamic, so verify structure rather than exact match
    expect(result.notification).toMatch(/^\n\[inbound:ci:failed\] timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(result.notification).toContain('type=ci:failed');
    expect(result.notification).toContain('source=github');
    expect(result.notification).toContain('repo=owner/repo');
    expect(result.notification).toContain('branch=main');
    expect(result.notification).toContain('url=https://example.com');
    expect(result.notification).toContain('summary="Build failed"');
    expect(result.notification).toContain('intent=triage');
    expect(written[0]).toBe(result.notification);
  });

  it('returns the notification string without trailing carriage return', () => {
    const result = writePtyNotification({
      kind: 'inbound-event',
      tag: 'inbound:ci:completed',
      fields: { type: 'ci:completed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'CI passed' },
      intent: 'inform',
      writeInput: () => true,
    });

    expect(result.notification.endsWith('\r')).toBe(false);
    expect(result.notification.endsWith('\n')).toBe(false);
  });

  it('sends Enter keystroke separately after a 150ms delay', () => {
    jest.useFakeTimers();
    try {
      const written: string[] = [];
      const writeInput = mock((data: string) => { written.push(data); return true; });

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
      writeInput: (data) => { written.push(data); return true; },
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
      writeInput: (data) => { written.push(data); return true; },
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
      writeInput: (data) => { written.push(data); return true; },
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
      writeInput: (data) => { written.push(data); return true; },
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
      writeInput: (data) => { written.push(data); return true; },
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
      writeInput: (data) => { written.push(data); return true; },
    });

    // After the tag, timestamp should be the first key=value pair
    expect(written[0]).toMatch(/^\n\[internal:timer\] timestamp=/);
  });

  // Q12 polarity (Issue #1654): on unmodified main, writeInput's boolean
  // result is discarded by the `(data: string) => void` callback type, so
  // writePtyNotification always schedules the delayed `\r` regardless of
  // whether the first write actually reached a live PTY. These two tests
  // must fail against unmodified main (no `written` field exists on the
  // return value, and the `\r` fires even when writeInput reports false).
  it('reports written: false and does not send the delayed Enter when writeInput rejects the write', () => {
    jest.useFakeTimers();
    try {
      const written: string[] = [];
      const writeInput = mock((data: string) => {
        written.push(data);
        return false;
      });

      const result = writePtyNotification({
        kind: 'internal-timer',
        tag: 'internal:timer',
        fields: { timerId: 'timer-1', action: 'check', fireCount: '1' },
        intent: 'inform',
        writeInput,
      });

      expect(result.written).toBe(false);
      expect(result.notification).toContain('[internal:timer]');
      expect(written).toHaveLength(1);

      jest.advanceTimersByTime(150);

      // No `\r` write should follow a rejected first write.
      expect(written).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports written: true and sends the delayed Enter when writeInput accepts the write', () => {
    jest.useFakeTimers();
    try {
      const written: string[] = [];
      const writeInput = mock((data: string) => {
        written.push(data);
        return true;
      });

      const result = writePtyNotification({
        kind: 'internal-timer',
        tag: 'internal:timer',
        fields: { timerId: 'timer-1', action: 'check', fireCount: '1' },
        intent: 'inform',
        writeInput,
      });

      expect(result.written).toBe(true);
      expect(written).toHaveLength(1);

      jest.advanceTimersByTime(150);

      expect(written).toHaveLength(2);
      expect(written[1]).toBe('\r');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('buildPtyNotificationText', () => {
  it('produces the exact same string writePtyNotification writes to the PTY (same-output equivalence)', () => {
    const written: string[] = [];

    const params = {
      kind: 'internal-message' as const,
      tag: 'internal:message' as const,
      fields: { source: 'session', from: 'sender-1', summary: 'hello world', path: '/tmp/msg' },
      intent: 'triage' as const,
    };

    // Both buildPtyNotificationText and writePtyNotification independently
    // call `new Date().toISOString()` for the timestamp field. Without a
    // frozen clock, the two calls below can straddle a millisecond boundary
    // on a loaded CI runner, producing two different timestamp strings and
    // failing the exact-equality assertion for a reason that has nothing to
    // do with whether the two functions actually agree (Issue #1321).
    // Freezing time makes this a genuine full-string equality check again:
    // the only variable removed is the wall clock, so any other divergence
    // between the two call paths still fails the assertion below.
    setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let built: string;
    let returnedFromWrite: { notification: string; written: boolean };
    try {
      built = buildPtyNotificationText(params);
      returnedFromWrite = writePtyNotification({ ...params, writeInput: (data) => { written.push(data); return true; } });
    } finally {
      setSystemTime();
    }

    expect(written[0]).toBe(built);
    expect(returnedFromWrite.notification).toBe(built);
  });

  it('does not schedule any timer (pure function)', () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    try {
      buildPtyNotificationText({
        kind: 'internal-message',
        tag: 'internal:message',
        fields: { source: 'session', from: 'sender-1', summary: 'hi', path: '/tmp/msg' },
        intent: 'inform',
      });
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('includes tag, fields, intent, and timestamp in the built string', () => {
    const result = buildPtyNotificationText({
      kind: 'inbound-event',
      tag: 'inbound:ci:failed',
      fields: { type: 'ci:failed', source: 'github', repo: 'owner/repo', branch: 'main', url: 'https://example.com', summary: 'Build failed' },
      intent: 'triage',
    });

    expect(result).toMatch(/^\n\[inbound:ci:failed\] timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(result).toContain('type=ci:failed');
    expect(result).toContain('intent=triage');
  });

  it('builds an internal-agent-spawn-failed notification with command, username, and exitCode (Issue #1294)', () => {
    const result = buildPtyNotificationText({
      kind: 'internal-agent-spawn-failed',
      tag: 'internal:agent-spawn-failed',
      fields: {
        command: 'claude',
        username: 'testuser',
        exitCode: '127',
        diagnosis: "usually means a required program is missing for user 'testuser': the spawn shell itself, or the agent command 'claude', is not installed or not on PATH",
        remedy: "install and authenticate the agent CLI for user 'testuser', or adjust this agent's command template -- check the server log's wrapperCommand field for this event to see which one was actually attempted",
      },
      intent: 'triage',
    });

    expect(result).toContain('[internal:agent-spawn-failed]');
    expect(result).toContain('command=claude');
    expect(result).toContain('username=testuser');
    expect(result).toContain('exitCode=127');
    expect(result).toContain('intent=triage');
  });

  it('builds an internal-worker-interrupted notification with every field (interrupted-turn parent notification)', () => {
    const result = buildPtyNotificationText({
      kind: 'internal-worker-interrupted',
      tag: 'internal:worker-interrupted',
      fields: {
        sessionId: 'child-session',
        workerId: 'child-worker',
        turnId: 'turn-1',
        cause: 'exit',
        exitReason: 'unexpected',
        exitCode: '1',
        summary: 'Embedded worker child-worker (session child-session): turn turn-1 was interrupted (exit, unexpected) and will not complete',
        hint: 'Re-send your instruction with send_session_message, or restart the worker; do not wait for a reply to the interrupted turn',
      },
      intent: 'triage',
    });

    expect(result).toContain('[internal:worker-interrupted]');
    expect(result).toContain('sessionId=child-session');
    expect(result).toContain('workerId=child-worker');
    expect(result).toContain('turnId=turn-1');
    expect(result).toContain('cause=exit');
    expect(result).toContain('exitReason=unexpected');
    expect(result).toContain('exitCode=1');
    expect(result).toContain(
      'summary="Embedded worker child-worker (session child-session): turn turn-1 was interrupted (exit, unexpected) and will not complete"',
    );
    expect(result).toContain(
      'hint="Re-send your instruction with send_session_message, or restart the worker; do not wait for a reply to the interrupted turn"',
    );
    expect(result).toContain('intent=triage');
    expect(result).toMatch(/^\n\[internal:worker-interrupted\] timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });
});

describe('extractNotificationSummary — internal-worker-interrupted', () => {
  it('returns the summary field for an internal-worker-interrupted notification', () => {
    const summary = extractNotificationSummary({
      kind: 'internal-worker-interrupted',
      tag: 'internal:worker-interrupted',
      fields: {
        sessionId: 'child-session',
        workerId: 'child-worker',
        turnId: 'turn-1',
        cause: 'unobserved',
        exitReason: 'server-restart',
        exitCode: 'unknown',
        summary: 'Embedded worker child-worker (session child-session): turn turn-1 was interrupted (unobserved, server-restart) and will not complete',
        hint: 'Re-send your instruction with send_session_message, or restart the worker; do not wait for a reply to the interrupted turn',
      },
      intent: 'triage',
    });

    expect(summary).toBe(
      'Embedded worker child-worker (session child-session): turn turn-1 was interrupted (unobserved, server-restart) and will not complete',
    );
  });

  it('returns undefined for a kind whose fields shape carries no summary (internal-timer)', () => {
    const summary = extractNotificationSummary({
      kind: 'internal-timer',
      tag: 'internal:timer',
      fields: { timerId: 't1', action: 'fire', fireCount: '1' },
      intent: 'inform',
    });

    expect(summary).toBeUndefined();
  });
});

describe('buildReplyInstructions', () => {
  // Issue #1696: fromSessionId is a self-identity argument that defaults to
  // the bearer token's session (resolveSelfIdentity), so the reply
  // instructions tell an embedded agent to OMIT it -- restating an id the
  // token already proves was the anti-pattern -- and a terminal agent (no
  // token) to pass the env var. Reach measured: reverting the line to either
  // superseded wording (pre-#1694 env-only, or #1694's "or the Session ID
  // stated in your system prompt") fails here.
  it('tells an embedded agent to OMIT fromSessionId (the bearer token identifies it) and a terminal agent to pass the env var', () => {
    const text = buildReplyInstructions('sender-123');
    expect(text).toContain('toSessionId: "sender-123"');
    expect(text).toContain(
      '- fromSessionId: omit it if you are an embedded agent (your bearer token identifies you); terminal agents pass AGENT_CONSOLE_SESSION_ID',
    );
    // Neither superseded wording: the pre-#1694 env-only line, nor the
    // #1694 "read it from your system prompt" line that #1696 retired
    // (restating an id the token already proves was the anti-pattern).
    expect(text).not.toContain('Use your AGENT_CONSOLE_SESSION_ID environment variable');
    expect(text).not.toContain('Session ID stated in your system prompt');
  });
});
