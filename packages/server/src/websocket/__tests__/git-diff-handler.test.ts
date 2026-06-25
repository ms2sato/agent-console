import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import type { GitDiffData, GitDiffServerMessage } from '@agent-console/shared';
import { createGitDiffHandlers, type GitDiffHandlerDependencies } from '../git-diff-handler.js';
import { AnnotationService } from '../../services/annotation-service.js';


describe('GitDiffHandler', () => {
  let mockWs: WSContext;
  let sentMessages: string[];
  let mockGetDiffData: ReturnType<typeof mock>;
  let mockResolveRef: ReturnType<typeof mock>;
  let mockResolveBaseSpec: ReturnType<typeof mock>;
  let mockStartWatching: ReturnType<typeof mock>;
  let mockStopWatching: ReturnType<typeof mock>;
  let handlers: ReturnType<typeof createGitDiffHandlers>;

  const mockDiffData: GitDiffData = {
    summary: {
      baseCommit: 'abc123',
      targetRef: 'working-dir',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      updatedAt: new Date().toISOString(),
    },
    rawDiff: '',
  };

  beforeEach(() => {
    sentMessages = [];

    // Create mock WebSocket context
    mockWs = {
      send: mock((msg: string) => {
        sentMessages.push(msg);
      }),
      close: mock(),
      readyState: 1, // OPEN
    } as unknown as WSContext;

    // Create mock dependencies. Each dep now accepts a requestUser arg
    // (Issue #869) but the mocks ignore it — these tests focus on the
    // handler's plumbing, not the privilege-elevation behavior of the
    // underlying service (covered by git-diff-service-elevation.test.ts).
    mockGetDiffData = mock(async () => mockDiffData);
    mockResolveRef = mock(async (ref: string) => {
      if (ref === 'main' || ref === 'HEAD') {
        return 'resolved-commit-hash';
      }
      return null;
    });
    // Default: re-resolution returns the spec verbatim (identity) so existing
    // hash-based assertions hold. Specific cases override this per-test.
    mockResolveBaseSpec = mock(async (spec: string) => {
      if (spec === 'merge-base:main') {
        return 'merge-base-commit-hash';
      }
      if (spec === 'merge-base:nonexistent-branch') {
        return null;
      }
      if (spec === 'main') {
        return 'resolved-commit-hash';
      }
      if (spec === 'invalid-branch') {
        return null;
      }
      return spec;
    });
    mockStartWatching = mock(() => {});
    mockStopWatching = mock(() => {});

    const deps: GitDiffHandlerDependencies = {
      getDiffData: mockGetDiffData,
      resolveRef: mockResolveRef,
      resolveBaseSpec: mockResolveBaseSpec,
      startWatching: mockStartWatching,
      stopWatching: mockStopWatching,
      getFileLines: mock(() => Promise.resolve([])),
      annotationService: new AnnotationService(),
    };

    handlers = createGitDiffHandlers(deps);
  });

  /** Helper to establish a connection before sending messages */
  async function connectWorker(baseCommit: string = 'base-commit', requestUser: string | null = null): Promise<void> {
    await handlers.handleConnection(mockWs, 'session-1', 'worker-1', '/repo/path', baseCommit, requestUser);
    sentMessages = [];
    mockGetDiffData.mockClear();
  }

  /** Helper to send a message to the connected worker */
  async function sendMessage(message: string): Promise<void> {
    await handlers.handleMessage(mockWs, 'session-1', 'worker-1', '/repo/path', message);
  }

  describe('handleConnection', () => {
    it('should send initial diff data on connection', async () => {
      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'base-commit',
        null
      );

      expect(mockWs.send).toHaveBeenCalled();
      expect(sentMessages.length).toBe(1);

      const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
      expect(sentMsg.type).toBe('diff-data');
      expect(sentMsg).toHaveProperty('data');
    });

    it('should call getDiffData with correct parameters', async () => {
      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'specific-commit',
        null
      );

      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'specific-commit', null, 'working-dir');
    });

    it('threads the captured requestUser into resolveBaseSpec / getDiffData', async () => {
      // Issue #869: a non-null requestUser must reach the underlying service so
      // multi-user mode can elevate git to the worktree-owning user.
      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'base-commit',
        'workspaceuser'
      );

      expect(mockResolveBaseSpec).toHaveBeenCalledWith('base-commit', '/repo/path', 'workspaceuser');
      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'base-commit', 'workspaceuser', 'working-dir');
    });

    it('should start file watching on connection', async () => {
      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'base-commit',
        null
      );

      expect(mockStartWatching).toHaveBeenCalledWith('/repo/path', expect.any(Function));
    });

    it('should send error if getDiffData throws', async () => {
      mockGetDiffData.mockImplementation(async () => {
        throw new Error('Git error');
      });

      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'base-commit',
        null
      );

      expect(sentMessages.length).toBe(1);
      const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
      expect(sentMsg.type).toBe('diff-error');
      expect(sentMsg).toHaveProperty('error', 'Git error');
    });
  });

  describe('handleDisconnection', () => {
    it('should not throw on disconnection', async () => {
      await expect(
        handlers.handleDisconnection('session-1', 'worker-1')
      ).resolves.toBeUndefined();
    });

    it('should stop file watching on disconnection after connection', async () => {
      // First connect
      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'base-commit',
        null
      );

      // Then disconnect
      await handlers.handleDisconnection('session-1', 'worker-1');

      expect(mockStopWatching).toHaveBeenCalledWith('/repo/path');
    });
  });

  describe('handleMessage', () => {
    describe('without active connection', () => {
      it('should send error when no connection exists', async () => {
        await sendMessage(JSON.stringify({ type: 'refresh' }));

        expect(sentMessages.length).toBe(1);
        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect(sentMsg).toHaveProperty('error', 'No active connection for this worker');
      });
    });

    describe('refresh message', () => {
      it('should send updated diff data on refresh', async () => {
        await connectWorker('current-base');

        await sendMessage(JSON.stringify({ type: 'refresh' }));

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'current-base', null, 'working-dir');
        expect(sentMessages.length).toBe(1);

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });

      it('forwards the captured requestUser into refresh re-resolution and diff', async () => {
        // Issue #869: file-change / refresh paths must keep using the same
        // requestUser captured at connection time, not silently drop it.
        await connectWorker('current-base', 'workspaceuser');
        mockResolveBaseSpec.mockClear();

        await sendMessage(JSON.stringify({ type: 'refresh' }));

        expect(mockResolveBaseSpec).toHaveBeenCalledWith('current-base', '/repo/path', 'workspaceuser');
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'current-base', 'workspaceuser', 'working-dir');
      });
    });

    describe('set-base-commit message', () => {
      it('should store the ref as the base spec and re-resolve it on diff for a valid ref', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'main' }));

        // The raw ref is stored as the spec and re-resolved via resolveBaseSpec.
        expect(mockResolveBaseSpec).toHaveBeenCalledWith('main', '/repo/path', null);
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', null, 'working-dir');

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });

      it('should surface an error (not a silent empty diff) when the spec cannot be resolved', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'invalid-branch' }));

        expect(mockResolveBaseSpec).toHaveBeenCalledWith('invalid-branch', '/repo/path', null);
        expect(mockGetDiffData).not.toHaveBeenCalled();

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect((sentMsg as { error: string }).error).toContain('Could not resolve diff base: invalid-branch');
      });

      it('should re-resolve a merge-base: spec on diff', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'merge-base:main' }));

        expect(mockResolveBaseSpec).toHaveBeenCalledWith('merge-base:main', '/repo/path', null);
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'merge-base-commit-hash', null, 'working-dir');

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });

      it('should surface an error when a merge-base: spec resolves to null (unrelated histories / deleted ref)', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'merge-base:nonexistent-branch' }));

        expect(mockResolveBaseSpec).toHaveBeenCalledWith('merge-base:nonexistent-branch', '/repo/path', null);
        expect(mockGetDiffData).not.toHaveBeenCalled();

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect((sentMsg as { error: string }).error).toContain('Could not resolve diff base: merge-base:nonexistent-branch');
      });

      // Validate-before-replace contract: a failed set-base-commit must NOT
      // clobber the last good spec. The previous behavior assigned
      // state.baseSpec before proving the new spec resolved, so a single bad
      // ref poisoned every later refresh / file-watch send.
      it('retains the previous base spec when re-resolution fails so later refreshes use the OLD spec', async () => {
        await connectWorker('old-base');

        // 'invalid-branch' resolves to null in the mock -> send must fail.
        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'invalid-branch' }));

        const failMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(failMsg.type).toBe('diff-error');
        expect((failMsg as { error: string }).error).toContain('Could not resolve diff base: invalid-branch');

        sentMessages = [];
        mockGetDiffData.mockClear();

        // A subsequent refresh must diff against the OLD good spec, not the bad one.
        await sendMessage(JSON.stringify({ type: 'refresh' }));

        expect(mockResolveBaseSpec).toHaveBeenCalledWith('old-base', '/repo/path', null);
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'old-base', null, 'working-dir');

        const refreshMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(refreshMsg.type).toBe('diff-data');
      });

      it('commits the new base spec when re-resolution succeeds', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'main' }));

        const setMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(setMsg.type).toBe('diff-data');

        sentMessages = [];
        mockGetDiffData.mockClear();

        // A subsequent refresh uses the newly committed spec, not 'old-base'.
        await sendMessage(JSON.stringify({ type: 'refresh' }));

        expect(mockResolveBaseSpec).toHaveBeenCalledWith('main', '/repo/path', null);
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', null, 'working-dir');
      });
    });

    describe('refresh after set-base-commit', () => {
      it('should use updated base commit from state', async () => {
        await connectWorker('old-base');

        // Update base commit
        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'main' }));
        sentMessages = [];
        mockGetDiffData.mockClear();

        // Refresh should use updated base, not 'old-base'
        await sendMessage(JSON.stringify({ type: 'refresh' }));

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', null, 'working-dir');
      });
    });

    describe('set-target-commit after set-base-commit', () => {
      it('should use updated base commit when sending diff data', async () => {
        await connectWorker('old-base');

        // Update base commit
        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'main' }));
        sentMessages = [];
        mockGetDiffData.mockClear();

        // Set target should use updated base, not 'old-base'
        await sendMessage(JSON.stringify({ type: 'set-target-commit', ref: 'HEAD' }));

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', null, 'resolved-commit-hash');
      });
    });

    describe('get-file-lines message', () => {
      it('sends file-lines response', async () => {
        // Establish connection first
        await handlers.handleConnection(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'base-commit',
          null
        );
        sentMessages = [];

        const deps = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          resolveBaseSpec: mockResolveBaseSpec,
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: mock(() => Promise.resolve(['line1', 'line2', 'line3'])),
          annotationService: new AnnotationService(),
        } satisfies GitDiffHandlerDependencies;
        const localHandlers = createGitDiffHandlers(deps);

        // Need to connect first to set up state
        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-2',
          '/repo/path',
          'base-commit',
          null
        );
        sentMessages = [];

        const message = JSON.stringify({
          type: 'get-file-lines',
          path: 'src/file.ts',
          startLine: 1,
          endLine: 3,
          ref: 'working-dir',
        });

        await localHandlers.handleMessage(
          mockWs,
          'session-1',
          'worker-2',
          '/repo/path',
          message
        );

        expect(sentMessages.length).toBe(1);
        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('file-lines');
        expect(sentMsg).toHaveProperty('path', 'src/file.ts');
        expect(sentMsg).toHaveProperty('startLine', 1);
        expect(sentMsg).toHaveProperty('lines', ['line1', 'line2', 'line3']);
      });

      it('threads requestUser into getFileLines for ref-based reads', async () => {
        // Issue #869: file-line reads at a ref must run as the worktree owner
        // so `git show` does not fail with dubious ownership.
        const getFileLinesMock = mock(() => Promise.resolve(['line1']));
        const deps: GitDiffHandlerDependencies = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          resolveBaseSpec: mockResolveBaseSpec,
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: getFileLinesMock,
          annotationService: new AnnotationService(),
        };
        const localHandlers = createGitDiffHandlers(deps);

        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-elevated-lines',
          '/repo/path',
          'base-commit',
          'workspaceuser'
        );
        sentMessages = [];

        await localHandlers.handleMessage(
          mockWs,
          'session-1',
          'worker-elevated-lines',
          '/repo/path',
          JSON.stringify({ type: 'get-file-lines', path: 'src/file.ts', startLine: 1, endLine: 1, ref: 'abc123' }),
        );

        expect(getFileLinesMock).toHaveBeenCalledWith('/repo/path', 'src/file.ts', 1, 1, 'abc123', 'workspaceuser');
      });

      it('sends error for path traversal attempt', async () => {
        const deps: GitDiffHandlerDependencies = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          resolveBaseSpec: mockResolveBaseSpec,
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: mock(() => Promise.reject(new Error('Invalid file path: ../etc/passwd'))),
          annotationService: new AnnotationService(),
        };
        const localHandlers = createGitDiffHandlers(deps);

        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-traversal',
          '/repo/path',
          'base-commit',
          null
        );
        sentMessages = [];

        const message = JSON.stringify({
          type: 'get-file-lines',
          path: '../etc/passwd',
          startLine: 1,
          endLine: 10,
          ref: 'working-dir',
        });

        await localHandlers.handleMessage(
          mockWs,
          'session-1',
          'worker-traversal',
          '/repo/path',
          message
        );

        expect(sentMessages.length).toBe(1);
        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect((sentMsg as { error: string }).error).toContain('Invalid file path');
      });

      it('sends error on failure', async () => {
        const deps: GitDiffHandlerDependencies = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          resolveBaseSpec: mockResolveBaseSpec,
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: mock(() => Promise.reject(new Error('File not found'))),
          annotationService: new AnnotationService(),
        };
        const localHandlers = createGitDiffHandlers(deps);

        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-3',
          '/repo/path',
          'base-commit',
          null
        );
        sentMessages = [];

        const message = JSON.stringify({
          type: 'get-file-lines',
          path: 'src/missing.ts',
          startLine: 1,
          endLine: 5,
          ref: 'working-dir',
        });

        await localHandlers.handleMessage(
          mockWs,
          'session-1',
          'worker-3',
          '/repo/path',
          message
        );

        expect(sentMessages.length).toBe(1);
        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect(sentMsg).toHaveProperty('error', 'File not found');
      });
    });

    describe('invalid message', () => {
      it('should send error for invalid JSON', async () => {
        await connectWorker();

        await sendMessage('not valid json');

        expect(sentMessages.length).toBe(1);
        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect(sentMsg).toHaveProperty('error', 'Invalid message format');
      });
    });
  });

  describe('updateBaseCommit', () => {
    it('should update connection state and send fresh diff data when connection exists', async () => {
      await connectWorker('old-base');

      await handlers.updateBaseCommit('worker-1', 'new-base-commit');

      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'new-base-commit', null, 'working-dir');
      expect(sentMessages.length).toBe(1);

      const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
      expect(sentMsg.type).toBe('diff-data');
    });

    it('should not throw when no connection exists for the workerId', async () => {
      // No connection established - should silently return
      await expect(
        handlers.updateBaseCommit('nonexistent-worker', 'some-commit')
      ).resolves.toBeUndefined();

      expect(mockGetDiffData).not.toHaveBeenCalled();
    });

    it('should use the new baseCommit (not the old one) when sending diff data', async () => {
      await connectWorker('original-base');

      await handlers.updateBaseCommit('worker-1', 'updated-base');
      sentMessages = [];
      mockGetDiffData.mockClear();

      // A subsequent refresh should also use the updated base commit
      await sendMessage(JSON.stringify({ type: 'refresh' }));

      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'updated-base', null, 'working-dir');
    });

    // Validate-before-replace: a server-pushed spec that fails to resolve must
    // not clobber the last good spec.
    it('retains the old base spec when the pushed spec is unresolvable', async () => {
      await connectWorker('original-base');

      // 'invalid-branch' resolves to null in the mock -> update must fail.
      await handlers.updateBaseCommit('worker-1', 'invalid-branch');

      const failMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
      expect(failMsg.type).toBe('diff-error');
      expect((failMsg as { error: string }).error).toContain('Could not resolve diff base: invalid-branch');

      sentMessages = [];
      mockGetDiffData.mockClear();

      // A subsequent refresh must diff against the OLD good spec, not the bad one.
      await sendMessage(JSON.stringify({ type: 'refresh' }));

      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'original-base', null, 'working-dir');
    });

    it('threads the captured requestUser through updateBaseCommit', async () => {
      // Issue #869: server-pushed base-commit updates (e.g. from
      // onDiffBaseCommitChanged) must keep using the same requestUser.
      await connectWorker('original-base', 'workspaceuser');
      mockResolveBaseSpec.mockClear();

      await handlers.updateBaseCommit('worker-1', 'updated-base');

      expect(mockResolveBaseSpec).toHaveBeenCalledWith('updated-base', '/repo/path', 'workspaceuser');
      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'updated-base', 'workspaceuser', 'working-dir');
    });
  });
});
