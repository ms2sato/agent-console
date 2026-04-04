import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { mockGit, resetGitMocks } from '../../__tests__/utils/mock-git-helper.js';
import {
  buildInternalWorktreeSession,
  buildInternalQuickSession,
  buildPersistedWorktreeSession,
  buildPersistedQuickSession,
  buildPersistedAgentWorker,
  buildPersistedGitDiffWorker,
} from '../../__tests__/utils/build-test-data.js';
import { SessionMetadataService, type SessionMetadataDeps } from '../session-metadata-service.js';
import type { InternalSession } from '../internal-types.js';
import type { PersistedSession, PersistedWorktreeSession, PersistedGitDiffWorker } from '../persistence-service.js';
import type { Session } from '@agent-console/shared';
import type { SessionRepository } from '../../repositories/session-repository.js';

function createMockSessionRepository(overrides?: Partial<SessionRepository>): SessionRepository {
  return {
    findAll: mock(() => Promise.resolve([])),
    findById: mock(() => Promise.resolve(null)),
    findByServerPid: mock(() => Promise.resolve([])),
    save: mock(() => Promise.resolve()),
    saveAll: mock(() => Promise.resolve()),
    delete: mock(() => Promise.resolve()),
    update: mock(() => Promise.resolve(true)),
    findPaused: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

function createMockDeps(overrides?: Partial<SessionMetadataDeps>): SessionMetadataDeps {
  return {
    getSession: mock(() => undefined),
    sessionRepository: createMockSessionRepository(),
    persistSession: mock(() => Promise.resolve()),
    toPublicSession: mock((session: InternalSession) => ({ id: session.id }) as Session),
    getSessionLifecycleCallbacks: mock(() => undefined),
    updateGitDiffWorkersAfterBranchRename: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('SessionMetadataService', () => {
  let deps: SessionMetadataDeps;
  let service: SessionMetadataService;

  beforeEach(() => {
    resetGitMocks();
    mockGit.getCurrentBranch.mockImplementation(() => Promise.resolve('old-branch'));

    deps = createMockDeps();
    service = new SessionMetadataService(deps);
  });

  describe('updateSessionMetadata - active session', () => {
    it('should update title for active session', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      const onSessionUpdated = mock(() => {});
      deps = createMockDeps({
        getSession: mock(() => session),
        getSessionLifecycleCallbacks: () => ({ onSessionUpdated }),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-1', { title: 'New Title' });

      expect(result.success).toBe(true);
      expect(result.title).toBe('New Title');
      expect(session.title).toBe('New Title');
      expect(deps.persistSession).toHaveBeenCalledWith(session);
      expect(onSessionUpdated).toHaveBeenCalledTimes(1);
    });

    it('should rename branch for active worktree session', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        getSession: mock(() => session),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-1', { branch: 'new-branch' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');
      expect(session.worktreeId).toBe('new-branch');
      expect(mockGit.getCurrentBranch).toHaveBeenCalledWith('/test/path');
      expect(mockGit.renameBranch).toHaveBeenCalledWith('old-branch', 'new-branch', '/test/path');
      expect(deps.updateGitDiffWorkersAfterBranchRename).toHaveBeenCalledWith('session-1');
    });

    it('should fail branch rename for quick session', async () => {
      const session = buildInternalQuickSession([], { locationPath: '/test/quick-path' });
      deps = createMockDeps({
        getSession: mock(() => session),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-2', { branch: 'new-branch' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Can only rename branch for worktree sessions');
    });

    it('should handle git rename failure for active session', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        getSession: mock(() => session),
      });
      service = new SessionMetadataService(deps);
      mockGit.renameBranch.mockImplementation(() => Promise.reject(new Error('git error')));

      const result = await service.updateSessionMetadata('session-1', { branch: 'new-branch' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('git error');
    });

    it('should succeed even when git-diff update fails for active session', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        getSession: mock(() => session),
        updateGitDiffWorkersAfterBranchRename: mock(() => Promise.reject(new Error('diff error'))),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-1', { branch: 'new-branch' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');
    });

    it('should update both title and branch for active session', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        getSession: mock(() => session),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-1', {
        title: 'New Title',
        branch: 'new-branch',
      });

      expect(result.success).toBe(true);
      expect(result.title).toBe('New Title');
      expect(result.branch).toBe('new-branch');
      expect(session.title).toBe('New Title');
      expect(session.worktreeId).toBe('new-branch');
    });
  });

  describe('updateSessionMetadata - inactive session', () => {
    it('should return error when session not found anywhere', async () => {
      const result = await service.updateSessionMetadata('nonexistent', { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('session_not_found');
    });

    it('should update title for inactive session', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'session-3', worktreeId: 'old-branch', locationPath: '/test/path' });
      const saveMock = mock((_session: PersistedSession) => Promise.resolve());
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
          save: saveMock,
        }),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-3', { title: 'Updated Title' });

      expect(result.success).toBe(true);
      expect(result.title).toBe('Updated Title');
      expect(saveMock).toHaveBeenCalledTimes(1);
      const savedSession = saveMock.mock.calls[0][0] as PersistedWorktreeSession;
      expect(savedSession.title).toBe('Updated Title');
    });

    it('should rename branch for inactive worktree session', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'session-3', worktreeId: 'old-branch', locationPath: '/test/path' });
      const saveMock = mock((_session: PersistedSession) => Promise.resolve());
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
          save: saveMock,
        }),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-3', { branch: 'new-branch' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');
      expect(mockGit.renameBranch).toHaveBeenCalledWith('old-branch', 'new-branch', '/test/path');
      const savedSession = saveMock.mock.calls[0][0] as PersistedWorktreeSession;
      expect(savedSession.worktreeId).toBe('new-branch');
    });

    it('should fail branch rename for inactive quick session', async () => {
      const persisted = buildPersistedQuickSession({ id: 'session-4', locationPath: '/test/quick-path' });
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
        }),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-4', { branch: 'new-branch' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Can only rename branch for worktree sessions');
    });

    it('should update git-diff workers base commit for inactive session', async () => {
      const persisted = buildPersistedWorktreeSession({
        id: 'session-3',
        worktreeId: 'old-branch',
        locationPath: '/test/path',
        workers: [
          buildPersistedAgentWorker({ id: 'w1', name: 'Claude' }),
          buildPersistedGitDiffWorker({ id: 'w2', name: 'Diff', baseCommit: 'old-commit' }),
        ],
      });
      const saveMock = mock((_session: PersistedSession) => Promise.resolve());
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
          save: saveMock,
        }),
      });
      service = new SessionMetadataService(deps);
      // calculateBaseCommit uses getDefaultBranch + getMergeBaseSafe
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve('main'));
      mockGit.getMergeBaseSafe.mockImplementation(() => Promise.resolve('new-merge-base'));

      const result = await service.updateSessionMetadata('session-3', { branch: 'new-branch' });

      expect(result.success).toBe(true);
      const savedSession = saveMock.mock.calls[0][0] as PersistedWorktreeSession;
      expect((savedSession.workers[1] as PersistedGitDiffWorker).baseCommit).toBe('new-merge-base');
      // Non-git-diff workers should be unchanged
      expect(savedSession.workers[0].type).toBe('agent');
    });

    it('should succeed branch rename even when calculateBaseCommit fails for inactive session', async () => {
      const persisted = buildPersistedWorktreeSession({
        id: 'session-3',
        worktreeId: 'old-branch',
        locationPath: '/test/path',
        workers: [
          buildPersistedGitDiffWorker({ id: 'w1', name: 'Diff', baseCommit: 'old-commit' }),
        ],
      });
      const saveMock = mock((_session: PersistedSession) => Promise.resolve());
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
          save: saveMock,
        }),
      });
      service = new SessionMetadataService(deps);
      // Make calculateBaseCommit fail by having getDefaultBranch throw
      mockGit.getDefaultBranch.mockImplementation(() => { throw new Error('git error'); });

      const result = await service.updateSessionMetadata('session-3', { branch: 'new-branch' });

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');
      // Workers should preserve original base commit since calculateBaseCommit failed
      const savedSession = saveMock.mock.calls[0][0] as PersistedWorktreeSession;
      expect((savedSession.workers[0] as PersistedGitDiffWorker).baseCommit).toBe('old-commit');
    });

    it('should update both title and branch for inactive session in single save', async () => {
      const persisted = buildPersistedWorktreeSession({ id: 'session-3', worktreeId: 'old-branch', locationPath: '/test/path' });
      const saveMock = mock((_session: PersistedSession) => Promise.resolve());
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
          save: saveMock,
        }),
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-3', {
        title: 'New Title',
        branch: 'new-branch',
      });

      expect(result.success).toBe(true);
      expect(result.title).toBe('New Title');
      expect(result.branch).toBe('new-branch');
      // Only one save call
      expect(saveMock).toHaveBeenCalledTimes(1);
      const savedSession = saveMock.mock.calls[0][0] as PersistedWorktreeSession;
      expect(savedSession.title).toBe('New Title');
      expect(savedSession.worktreeId).toBe('new-branch');
    });

    it('should use HEAD as fallback when calculateBaseCommit returns null', async () => {
      const persisted = buildPersistedWorktreeSession({
        id: 'session-3',
        worktreeId: 'old-branch',
        locationPath: '/test/path',
        workers: [
          buildPersistedGitDiffWorker({ id: 'w1', name: 'Diff', baseCommit: 'old-commit' }),
        ],
      });
      const saveMock = mock((_session: PersistedSession) => Promise.resolve());
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
          save: saveMock,
        }),
      });
      service = new SessionMetadataService(deps);
      // Make calculateBaseCommit return null: getDefaultBranch returns null, gitSafe returns null
      mockGit.getDefaultBranch.mockImplementation(() => Promise.resolve(null));
      mockGit.gitSafe.mockImplementation(() => Promise.resolve(null));

      await service.updateSessionMetadata('session-3', { branch: 'new-branch' });

      const savedSession = saveMock.mock.calls[0][0] as PersistedWorktreeSession;
      expect((savedSession.workers[0] as PersistedGitDiffWorker).baseCommit).toBe('HEAD');
    });
  });

  describe('renameBranch', () => {
    it('should delegate to updateSessionMetadata with branch parameter', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        getSession: mock(() => session),
      });
      service = new SessionMetadataService(deps);

      const result = await service.renameBranch('session-1', 'new-branch');

      expect(result.success).toBe(true);
      expect(result.branch).toBe('new-branch');
      expect(mockGit.renameBranch).toHaveBeenCalledWith('old-branch', 'new-branch', '/test/path');
    });
  });

  describe('callback broadcasting', () => {
    it('should not broadcast for inactive session updates', async () => {
      const onSessionUpdated = mock(() => {});
      const persisted = buildPersistedWorktreeSession({ id: 'session-3', worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        sessionRepository: createMockSessionRepository({
          findById: mock(() => Promise.resolve(persisted)),
        }),
        getSessionLifecycleCallbacks: () => ({ onSessionUpdated }),
      });
      service = new SessionMetadataService(deps);

      await service.updateSessionMetadata('session-3', { title: 'New Title' });

      expect(onSessionUpdated).not.toHaveBeenCalled();
    });

    it('should broadcast for active session updates', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      const onSessionUpdated = mock(() => {});
      deps = createMockDeps({
        getSession: mock(() => session),
        getSessionLifecycleCallbacks: () => ({ onSessionUpdated }),
      });
      service = new SessionMetadataService(deps);

      await service.updateSessionMetadata('session-1', { title: 'New Title' });

      expect(onSessionUpdated).toHaveBeenCalledTimes(1);
    });

    it('should handle missing lifecycle callbacks gracefully', async () => {
      const session = buildInternalWorktreeSession([], { worktreeId: 'old-branch', locationPath: '/test/path' });
      deps = createMockDeps({
        getSession: mock(() => session),
        getSessionLifecycleCallbacks: () => undefined,
      });
      service = new SessionMetadataService(deps);

      const result = await service.updateSessionMetadata('session-1', { title: 'New Title' });

      expect(result.success).toBe(true);
    });
  });
});
