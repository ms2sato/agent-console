import { describe, expect, it, mock } from 'bun:test';
import type { InboundSystemEvent, Session, InboundEventSummary } from '@agent-console/shared';
import { createInboundHandlers, formatFieldValue } from '../inbound/handlers.js';
import type { SessionManager } from '../session-manager.js';

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

function createReviewCommentEvent(): InboundSystemEvent {
  return {
    type: 'pr:review_comment',
    source: 'github',
    timestamp: '2024-01-01T00:00:00Z',
    metadata: {
      repositoryName: 'owner/repo',
      branch: 'feature-branch',
      url: 'https://github.com/owner/repo/pull/7#discussion_r123',
    },
    payload: {},
    summary: 'Review comment on PR #7 by reviewer (src/index.ts:42): Please fix this',
  };
}

function createMockSession(): Session {
  return {
    id: 'session-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'repo',
    worktreeId: 'feature-branch',
    isMainWorktree: false,
    locationPath: '/worktrees/repo',
    status: 'active',
    activationState: 'running',
    createdAt: '2024-01-01T00:00:00Z',
    workers: [
      { id: 'worker-1', type: 'agent', name: 'Claude', agentId: 'claude-code-builtin', activated: true, createdAt: '2024-01-01T00:00:00Z' },
    ],
  };
}

describe('AgentWorkerHandler', () => {
  it('handles pr:review_comment with intent=triage', async () => {
    let capturedMessage = '';
    const mockSessionManager = {
      getSession: mock(() => createMockSession()),
      writeWorkerInput: mock((_sessionId: string, _workerId: string, data: string) => {
        capturedMessage = data;
        return true;
      }),
    } as unknown as SessionManager;

    const handlers = createInboundHandlers({
      sessionManager: mockSessionManager,
      broadcastToApp: () => {},
    });
    const agentHandler = handlers.find((h) => h.handlerId === 'agent-worker')!;

    const result = await agentHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(capturedMessage).toContain('intent=triage');
    expect(capturedMessage).toContain('[inbound:pr:review_comment]');
    expect(capturedMessage).toContain('type=pr:review_comment');
  });
});

describe('UINotificationHandler', () => {
  it('broadcasts pr:review_comment event', async () => {
    let capturedBroadcast: { type: string; sessionId: string; event: InboundEventSummary } | undefined;
    const broadcastToApp = mock((message: { type: 'inbound-event'; sessionId: string; event: InboundEventSummary }) => {
      capturedBroadcast = message;
    });

    const handlers = createInboundHandlers({
      sessionManager: {} as SessionManager,
      broadcastToApp,
    });
    const uiHandler = handlers.find((h) => h.handlerId === 'ui-notification')!;

    const result = await uiHandler.handle(createReviewCommentEvent(), { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(broadcastToApp).toHaveBeenCalledTimes(1);
    expect(capturedBroadcast).toBeDefined();
    expect(capturedBroadcast!.type).toBe('inbound-event');
    expect(capturedBroadcast!.sessionId).toBe('session-1');
    expect(capturedBroadcast!.event.type).toBe('pr:review_comment');
    expect(capturedBroadcast!.event.source).toBe('github');
    expect(capturedBroadcast!.event.summary).toContain('PR #7');
    expect(capturedBroadcast!.event.metadata.repositoryName).toBe('owner/repo');
  });
});
