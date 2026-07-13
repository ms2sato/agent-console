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
  isShared: false,
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
  isShared: false,
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
  // Issue #905: required (not optional) on the wire so every broadcast
  // carries a defined value; server derives via getSourceReposDir().
  clonedSourceRepoPath: null,
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

    it('should accept session with initiatedBy set', () => {
      const output = expectValid({
        type: 'session-created',
        session: {
          ...worktreeSession,
          createdBy: 'shared-account-uuid',
          initiatedBy: 'caller-uuid',
        },
      });
      if (output.type === 'session-created' && 'initiatedBy' in output.session) {
        expect(output.session.initiatedBy).toBe('caller-uuid');
      }
    });

    it('should accept session without initiatedBy (optional)', () => {
      expectValid({
        type: 'session-created',
        session: { ...worktreeSession },
      });
    });

    it('should reject session with non-string initiatedBy', () => {
      expectInvalid({
        type: 'session-created',
        session: { ...worktreeSession, initiatedBy: 123 },
      });
    });

    it('should accept session with isShared: true', () => {
      const output = expectValid({
        type: 'session-created',
        session: { ...worktreeSession, isShared: true },
      });
      if (output.type === 'session-created') {
        expect(output.session.isShared).toBe(true);
      }
    });

    it('should accept session with isShared: false', () => {
      const output = expectValid({
        type: 'session-updated',
        session: { ...quickSession, isShared: false },
      });
      if (output.type === 'session-updated') {
        expect(output.session.isShared).toBe(false);
      }
    });

    it('should reject session with non-boolean isShared', () => {
      expectInvalid({
        type: 'session-created',
        session: { ...worktreeSession, isShared: 'true' },
      });
    });

    it('should reject session missing isShared (now required)', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { isShared: _omit, ...sessionWithoutIsShared } = worktreeSession;
      expectInvalid({
        type: 'session-created',
        session: sessionWithoutIsShared,
      });
    });

    // Issue #914: createdByUsername derived field must pass through safeParse
    // so the client receives the server-resolved OS username for sidebar
    // display in multi-user mode. Prior to this schema entry the field was
    // silently stripped, leaving the label hidden even when the server emitted
    // it.
    it('should accept session with createdByUsername set to a string', () => {
      const output = expectValid({
        type: 'session-created',
        session: { ...worktreeSession, createdBy: 'user-uuid', createdByUsername: 'ms2sato' },
      });
      if (output.type === 'session-created' && 'createdByUsername' in output.session) {
        expect(output.session.createdByUsername).toBe('ms2sato');
      } else {
        throw new Error('createdByUsername was stripped by the schema');
      }
    });

    it('should accept session with createdByUsername set to null (deleted user / legacy)', () => {
      const output = expectValid({
        type: 'session-updated',
        session: { ...quickSession, createdByUsername: null },
      });
      if (output.type === 'session-updated' && 'createdByUsername' in output.session) {
        expect(output.session.createdByUsername).toBeNull();
      } else {
        throw new Error('createdByUsername was stripped by the schema');
      }
    });

    it('should reject session with non-string non-null createdByUsername', () => {
      expectInvalid({
        type: 'session-created',
        session: { ...worktreeSession, createdByUsername: 123 },
      });
    });

    it('should accept session with initialPromptDelivered set to true', () => {
      const output = expectValid({
        type: 'session-created',
        session: { ...worktreeSession, initialPrompt: 'Do something', initialPromptDelivered: true },
      });
      if (output.type === 'session-created' && 'initialPromptDelivered' in output.session) {
        expect(output.session.initialPromptDelivered).toBe(true);
      } else {
        throw new Error('initialPromptDelivered was stripped by the schema');
      }
    });

    it('should accept session without initialPromptDelivered (optional)', () => {
      const output = expectValid({
        type: 'session-updated',
        session: { ...quickSession },
      });
      if (output.type === 'session-updated' && 'initialPromptDelivered' in output.session) {
        expect(output.session.initialPromptDelivered).toBeUndefined();
      }
    });

    it('should reject session with non-boolean initialPromptDelivered', () => {
      expectInvalid({
        type: 'session-created',
        session: { ...worktreeSession, initialPromptDelivered: 'yes' },
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

    it('should accept repository with clonedSourceRepoPath set to a string', () => {
      expectValid({
        type: 'repository-created',
        repository: {
          ...repository,
          clonedSourceRepoPath: '/var/lib/agent-console/source-repos/org/repo',
        },
      });
    });

    it('should accept repository with clonedSourceRepoPath set to null', () => {
      expectValid({
        type: 'repository-created',
        repository: { ...repository, clonedSourceRepoPath: null },
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
        sessionIds: ['session-1'],
      });
    });

    it('should accept worktree-deletion-failed', () => {
      expectValid({
        type: 'worktree-deletion-failed',
        taskId: 'task-1',
        sessionIds: ['session-1'],
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

  describe('schema-version', () => {
    it('should accept the schema-version frame', () => {
      const output = expectValid({ type: 'schema-version', version: 'cf7b17ac06edc357' });
      expect(output.type).toBe('schema-version');
      if (output.type === 'schema-version') {
        expect(output.version).toBe('cf7b17ac06edc357');
      }
    });

    it('should reject a schema-version frame missing version', () => {
      expectInvalid({ type: 'schema-version' });
    });
  });

  describe('strict-parse contract (unknown-key rejection)', () => {
    it('should reject an unknown key at the top level of a message', () => {
      const result = v.safeParse(AppServerMessageSchema, {
        type: 'review-queue-updated',
        unexpectedField: 'leaked',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.issues)).toContain('unexpectedField');
      }
    });

    it('should reject an unknown key nested inside a session in sessions-sync', () => {
      const result = v.safeParse(AppServerMessageSchema, {
        type: 'sessions-sync',
        sessions: [{ ...worktreeSession, unexpectedField: 'leaked' }],
        activityStates: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.issues)).toContain('unexpectedField');
      }
    });
  });

  describe('embedded agent messages', () => {
    const embeddedAgentDefinition = {
      id: 'def-1',
      name: 'Ollama qwen3:32b',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      createdBy: 'user-uuid',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    it('should accept embedded-agent-created', () => {
      const output = expectValid({ type: 'embedded-agent-created', embeddedAgent: embeddedAgentDefinition });
      expect(output.type).toBe('embedded-agent-created');
    });

    it('should accept embedded-agent-updated', () => {
      expectValid({ type: 'embedded-agent-updated', embeddedAgent: embeddedAgentDefinition });
    });

    it('should accept embedded-agent-deleted', () => {
      const output = expectValid({ type: 'embedded-agent-deleted', embeddedAgentId: 'def-1' });
      expect(output.type).toBe('embedded-agent-deleted');
    });

    it('should reject embedded-agent-deleted missing embeddedAgentId', () => {
      expectInvalid({ type: 'embedded-agent-deleted' });
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
            { id: 'w4', type: 'embedded-agent', name: 'Embedded', createdAt: '2026-01-01T00:00:00Z', embeddedAgentId: 'def-1', activated: false },
          ],
        },
      });
    });

    it('should retain embeddedAgentId and activated on an embedded-agent worker', () => {
      const output = expectValid({
        type: 'session-created',
        session: {
          ...worktreeSession,
          workers: [
            { id: 'w4', type: 'embedded-agent', name: 'Embedded', createdAt: '2026-01-01T00:00:00Z', embeddedAgentId: 'def-1', activated: true },
          ],
        },
      });
      if (output.type === 'session-created') {
        const worker = output.session.workers[0];
        expect(worker.type).toBe('embedded-agent');
        if (worker.type === 'embedded-agent') {
          expect(worker.embeddedAgentId).toBe('def-1');
          expect(worker.activated).toBe(true);
        }
      }
    });

    it('should reject an embedded-agent worker with an unknown key', () => {
      expectInvalid({
        type: 'session-created',
        session: {
          ...worktreeSession,
          workers: [
            { id: 'w4', type: 'embedded-agent', name: 'Embedded', createdAt: '2026-01-01T00:00:00Z', embeddedAgentId: 'def-1', activated: true, leaked: 'x' },
          ],
        },
      });
    });
  });
});
