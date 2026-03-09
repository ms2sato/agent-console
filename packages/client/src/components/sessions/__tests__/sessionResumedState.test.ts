/**
 * Tests for resolveResumedState - the state transition logic when a session is resumed.
 *
 * When a session-resumed event arrives, the client must decide whether to show
 * the active terminal UI or the disconnected reconnection UI, based on whether
 * PTY workers are actually running.
 */
import { describe, it, expect } from 'bun:test';
import type { Session } from '@agent-console/shared';
import { resolveResumedState } from '../sessionResumedState';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    type: 'worktree',
    repositoryId: 'repo-1',
    repositoryName: 'my-repo',
    worktreeId: 'feat/test',
    isMainWorktree: false,
    locationPath: '/path/to/worktree',
    status: 'active',
    activationState: 'running',
    createdAt: new Date().toISOString(),
    workers: [
      { id: 'agent-worker-1', type: 'agent', name: 'Claude Code', agentId: 'claude-code', createdAt: new Date().toISOString(), activated: true },
      { id: 'terminal-worker-1', type: 'terminal', name: 'Terminal', createdAt: new Date().toISOString(), activated: true },
    ],
    ...overrides,
  } as Session;
}

describe('resolveResumedState', () => {
  describe('transitions to disconnected', () => {
    it('should return disconnected when activationState is hibernated', () => {
      const session = createMockSession({
        activationState: 'hibernated',
        status: 'active',
      });

      const result = resolveResumedState(session);

      expect(result.type).toBe('disconnected');
      expect(result.session).toBe(session);
    });

    it('should return disconnected when status is not active', () => {
      const session = createMockSession({
        activationState: 'running',
        status: 'inactive',
      });

      const result = resolveResumedState(session);

      expect(result.type).toBe('disconnected');
      expect(result.session).toBe(session);
    });

    it('should return disconnected when both activationState is hibernated and status is inactive', () => {
      const session = createMockSession({
        activationState: 'hibernated',
        status: 'inactive',
      });

      const result = resolveResumedState(session);

      expect(result.type).toBe('disconnected');
      expect(result.session).toBe(session);
    });
  });

  describe('transitions to active', () => {
    it('should return active when activationState is running and status is active', () => {
      const session = createMockSession({
        activationState: 'running',
        status: 'active',
      });

      const result = resolveResumedState(session);

      expect(result.type).toBe('active');
      expect(result.session).toBe(session);
    });
  });

  describe('preserves session reference', () => {
    it('should pass through the exact session object in both outcomes', () => {
      const activeSession = createMockSession({ activationState: 'running', status: 'active' });
      const hibernatedSession = createMockSession({ activationState: 'hibernated', status: 'active' });

      const activeResult = resolveResumedState(activeSession);
      const disconnectedResult = resolveResumedState(hibernatedSession);

      // Verify the same object reference is preserved (not a copy)
      expect(activeResult.session).toBe(activeSession);
      expect(disconnectedResult.session).toBe(hibernatedSession);
    });
  });
});
