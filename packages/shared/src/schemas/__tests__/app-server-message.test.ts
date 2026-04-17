import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { AppServerMessageSchema } from '../app-server-message';

// Helper to assert valid parse
function expectValid(data: unknown) {
  const result = v.safeParse(AppServerMessageSchema, data);
  if (!result.success) {
    throw new Error(`Expected valid but got: ${JSON.stringify(result.issues.map(i => i.message))}`);
  }
  return result.output;
}

// Helper to assert invalid parse
function expectInvalid(data: unknown) {
  const result = v.safeParse(AppServerMessageSchema, data);
  expect(result.success).toBe(false);
}

// Reusable test data
const worktreeSession = {
  type: 'worktree' as const,
  id: 'session-1',
  locationPath: '/path/to/worktree',
  status: 'active' as const,
  activationState: 'running' as const,
  createdAt: '2026-01-01T00:00:00Z',
  workers: [],
  repositoryId: 'repo-1',
  repositoryName: 'my-repo',
  worktreeId: 'feature-branch',
  isMainWorktree: false,
  recoveryState: 'healthy' as const,
};

const quickSession = {
  type: 'quick' as const,
  id: 'session-2',
  locationPath: '/tmp/quick',
  status: 'active' as const,
  activationState: 'running' as const,
  createdAt: '2026-01-01T00:00:00Z',
  workers: [],
  recoveryState: 'healthy' as const,
};

const agentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  isBuiltIn: true,
  createdAt: '2026-01-01T00:00:00Z',
  commandTemplate: 'claude {{prompt}}',
  capabilities: {
    supportsContinue: true,
    supportsHeadlessMode: true,
    supportsActivityDetection: true,
  },
};

const repository = {
  id: 'repo-1',
  name: 'my-repo',
  path: '/path/to/repo',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('AppServerMessageSchema', () => {
  describe('discriminated union resolution', () => {
    it('should resolve by type field', () => {
      const output = expectValid({ type: 'review-queue-updated' });
      expect(output.type).toBe('review-queue-updated');
    });

    it('should reject unknown type', () => {
      expectInvalid({ type: 'unknown-type' });
    });

    it('should reject missing type', () => {
      expectInvalid({ sessionId: 'test' });
    });

    it('should reject non-object', () => {
      expectInvalid('string');
      expectInvalid(42);
      expectInvalid(null);
    });
  });

  describe('sessions-sync', () => {
    it('should accept valid payload', () => {
      const output = expectValid({
        type: 'sessions-sync',
        sessions: [worktreeSession, quickSession],
        activityStates: [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'active' },
        ],
      });
      expect(output.type).toBe('sessions-sync');
      if (output.type === 'sessions-sync') {
        expect(output.sessions).toHaveLength(2);
        expect(output.activityStates).toHaveLength(1);
      }
    });

    it('should accept empty arrays', () => {
      const output = expectValid({
        type: 'sessions-sync',
        sessions: [],
        activityStates: [],
      });
      if (output.type === 'sessions-sync') {
        expect(output.sessions).toHaveLength(0);
      }
    });

    it('should reject missing sessions', () => {
      expectInvalid({ type: 'sessions-sync', activityStates: [] });
    });
  });

  describe('session-created / session-updated', () => {
    it('should accept worktree session', () => {
      const output = expectValid({ type: 'session-created', session: worktreeSession });
      expect(output.type).toBe('session-created');
    });

    it('should accept quick session', () => {
      const output = expectValid({ type: 'session-updated', session: quickSession });
      expect(output.type).toBe('session-updated');
    });

    it('should accept session with optional fields', () => {
      expectValid({
        type: 'session-created',
        session: {
          ...worktreeSession,
          title: 'My Session',
          initialPrompt: 'Do something',
          pausedAt: '2026-01-01T01:00:00Z',
          parentSessionId: 'parent-1',
          parentWorkerId: 'parent-w-1',
          createdBy: 'user-uuid',
        },
      });
    });

    it('should reject missing session', () => {
      expectInvalid({ type: 'session-created' });
    });
  });

  describe('session-deleted', () => {
    it('should accept valid payload', () => {
      const output = expectValid({ type: 'session-deleted', sessionId: 'session-1' });
      expect(output.type).toBe('session-deleted');
    });

    it('should reject missing sessionId', () => {
      expectInvalid({ type: 'session-deleted' });
    });
  });

  describe('session-paused', () => {
    it('should accept payload with full session', () => {
      const output = expectValid({
        type: 'session-paused',
        session: { ...worktreeSession, activationState: 'hibernated', pausedAt: '2026-01-01T01:00:00Z' },
      });
      expect(output.type).toBe('session-paused');
    });

    it('should reject old-style payload with sessionId/pausedAt', () => {
      expectInvalid({ type: 'session-paused', sessionId: 'session-1', pausedAt: '2026-01-01T01:00:00Z' });
    });

    it('should reject session with activationState: running', () => {
      expectInvalid({
        type: 'session-paused',
        session: { ...worktreeSession, activationState: 'running' },
      });
    });

    it('should reject session without pausedAt', () => {
      expectInvalid({
        type: 'session-paused',
        session: { ...worktreeSession, activationState: 'hibernated' },
      });
    });
  });

  describe('session-resumed', () => {
    it('should accept payload with session and activityStates', () => {
      const output = expectValid({
        type: 'session-resumed',
        session: { ...worktreeSession, activationState: 'running' },
        activityStates: [
          { sessionId: 'session-1', workerId: 'worker-1', activityState: 'idle' },
        ],
      });
      expect(output.type).toBe('session-resumed');
    });

    it('should reject missing activityStates', () => {
      expectInvalid({ type: 'session-resumed', session: { ...worktreeSession, activationState: 'running' } });
    });

    it('should reject session with activationState: hibernated', () => {
      expectInvalid({
        type: 'session-resumed',
        session: { ...worktreeSession, activationState: 'hibernated' },
        activityStates: [],
      });
    });
  });

  describe('worker-activity', () => {
    it('should accept valid payload', () => {
      const output = expectValid({
        type: 'worker-activity',
        sessionId: 'session-1',
        workerId: 'worker-1',
        activityState: 'asking',
      });
      expect(output.type).toBe('worker-activity');
    });

    it('should reject invalid activityState', () => {
      expectInvalid({
        type: 'worker-activity',
        sessionId: 'session-1',
        workerId: 'worker-1',
        activityState: 'invalid',
      });
    });
  });

  describe('worker-activated', () => {
    it('should accept valid payload', () => {
      expectValid({ type: 'worker-activated', sessionId: 's1', workerId: 'w1' });
    });
  });

  describe('agent messages', () => {
    it('should accept agents-sync', () => {
      const output = expectValid({ type: 'agents-sync', agents: [agentDefinition] });
      expect(output.type).toBe('agents-sync');
    });

    it('should accept agent-created', () => {
      expectValid({ type: 'agent-created', agent: agentDefinition });
    });

    it('should accept agent-updated', () => {
      expectValid({ type: 'agent-updated', agent: agentDefinition });
    });

    it('should accept agent-deleted', () => {
      expectValid({ type: 'agent-deleted', agentId: 'agent-1' });
    });
  });

  describe('repository messages', () => {
    it('should accept repositories-sync', () => {
      expectValid({ type: 'repositories-sync', repositories: [repository] });
    });

    it('should accept repository-created', () => {
      expectValid({ type: 'repository-created', repository });
    });

    it('should accept repository-updated', () => {
      expectValid({ type: 'repository-updated', repository });
    });

    it('should accept repository-deleted', () => {
      expectValid({ type: 'repository-deleted', repositoryId: 'repo-1' });
    });

    it('should accept repository with optional fields', () => {
      expectValid({
        type: 'repository-created',
        repository: {
          ...repository,
          remoteUrl: 'https://github.com/org/repo',
          setupCommand: 'bun install',
          cleanupCommand: null,
          envVars: 'FOO=bar',
          description: 'A repo',
          defaultAgentId: 'claude-code',
        },
      });
    });
  });

  describe('worktree lifecycle messages', () => {
    it('should accept worktree-creation-completed', () => {
      expectValid({
        type: 'worktree-creation-completed',
        taskId: 'task-1',
        worktree: { path: '/wt', branch: 'feat', isMain: false, repositoryId: 'repo-1' },
        session: worktreeSession,
      });
    });

    it('should accept worktree-creation-completed with null session', () => {
      expectValid({
        type: 'worktree-creation-completed',
        taskId: 'task-1',
        worktree: { path: '/wt', branch: 'feat', isMain: false, repositoryId: 'repo-1' },
        session: null,
      });
    });

    it('should accept worktree-creation-failed', () => {
      expectValid({
        type: 'worktree-creation-failed',
        taskId: 'task-1',
        error: 'Branch already exists',
      });
    });

    it('should accept worktree-deletion-completed', () => {
      expectValid({
        type: 'worktree-deletion-completed',
        taskId: 'task-1',
        sessionId: 'session-1',
      });
    });

    it('should accept worktree-deletion-failed', () => {
      expectValid({
        type: 'worktree-deletion-failed',
        taskId: 'task-1',
        sessionId: 'session-1',
        error: 'Uncommitted changes',
        gitStatus: 'M file.ts',
      });
    });

    it('should accept worktree-pull-completed', () => {
      expectValid({
        type: 'worktree-pull-completed',
        taskId: 'task-1',
        worktreePath: '/wt',
        branch: 'main',
        commitsPulled: 3,
      });
    });

    it('should accept worktree-pull-failed', () => {
      expectValid({
        type: 'worktree-pull-failed',
        taskId: 'task-1',
        worktreePath: '/wt',
        error: 'Merge conflict',
      });
    });
  });

  describe('worker-message', () => {
    it('should accept valid payload', () => {
      expectValid({
        type: 'worker-message',
        message: {
          id: 'msg-1',
          sessionId: 'session-1',
          fromWorkerId: 'w1',
          fromWorkerName: 'Agent 1',
          toWorkerId: 'w2',
          toWorkerName: 'Agent 2',
          content: 'Hello',
          timestamp: '2026-01-01T00:00:00Z',
        },
      });
    });
  });

  describe('inbound-event', () => {
    it('should accept valid payload', () => {
      expectValid({
        type: 'inbound-event',
        sessionId: 'session-1',
        event: {
          type: 'pr:merged',
          source: 'github',
          summary: 'PR #42 was merged',
          metadata: { repositoryName: 'org/repo', branch: 'main' },
        },
      });
    });

    it('should reject invalid event type', () => {
      expectInvalid({
        type: 'inbound-event',
        sessionId: 'session-1',
        event: {
          type: 'invalid:type',
          source: 'github',
          summary: 'test',
          metadata: {},
        },
      });
    });
  });

  describe('worker-restarted', () => {
    it('should accept payload with activityState', () => {
      const output = expectValid({
        type: 'worker-restarted',
        sessionId: 'session-1',
        workerId: 'worker-1',
        activityState: 'unknown',
      });
      expect(output.type).toBe('worker-restarted');
    });

    it('should reject old-style payload without activityState', () => {
      expectInvalid({
        type: 'worker-restarted',
        sessionId: 'session-1',
        workerId: 'worker-1',
      });
    });
  });

  describe('memo-updated', () => {
    it('should accept valid payload', () => {
      expectValid({ type: 'memo-updated', sessionId: 'session-1', content: '# Notes' });
    });
  });

  describe('review-queue-updated', () => {
    it('should accept valid payload', () => {
      expectValid({ type: 'review-queue-updated' });
    });
  });

  describe('session with workers', () => {
    it('should validate session containing all worker types', () => {
      expectValid({
        type: 'session-created',
        session: {
          ...worktreeSession,
          workers: [
            { id: 'w1', type: 'agent', name: 'Agent', agentId: 'claude-code', createdAt: '2026-01-01T00:00:00Z', activated: true },
            { id: 'w2', type: 'terminal', name: 'Terminal', createdAt: '2026-01-01T00:00:00Z', activated: true },
            { id: 'w3', type: 'git-diff', name: 'Diff', createdAt: '2026-01-01T00:00:00Z', baseCommit: 'abc123' },
          ],
        },
      });
    });
  });
});
