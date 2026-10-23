import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import type { GitDiffData, GitDiffServerMessage } from '@agent-console/shared';
import { createGitDiffHandlers, type GitDiffHandlerDependencies } from '../git-diff-handler.js';
import { AnnotationService } from '../../services/annotation-service.js';
import { startWatching as realStartWatching } from '../../services/git-diff-service.js';
import { asWSContext } from './ws-test-helpers.js';


describe('GitDiffHandler', () => {
  let mockWs: WSContext;
  let sentMessages: string[];
  let mockGetDiffData: ReturnType<typeof mock>;
  let mockResolveRef: ReturnType<typeof mock>;
  let mockResolveBaseSpec: ReturnType<typeof mock>;
  let mockStartWatching: ReturnType<typeof mock>;
  let unsubscribes: Array<ReturnType<typeof mock>>;
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
    mockWs = asWSContext({
      send: mock((msg: string) => {
        sentMessages.push(msg);
      }),
      close: mock(),
      readyState: 1, // OPEN
    });

    // Create mock dependencies
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
    unsubscribes = [];
    mockStartWatching = mock(() => {
      const unsubscribe = mock(() => {});
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    });

    const deps: GitDiffHandlerDependencies = {
      getDiffData: mockGetDiffData,
      resolveRef: mockResolveRef,
      resolveBaseSpec: mockResolveBaseSpec,
      startWatching: mockStartWatching,
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

    it('keeps the diff connection up when the underlying watch fails: diff-data is still sent, no diff-error, no close', async () => {
      // The REAL startWatching over a path `fs.watch` cannot open (it does not exist). Before the shared
      // watcher, startWatching rethrew, handleConnection rejected, and routes.ts answered
      // `diff-error: Connection failed` and closed the socket: an unwatchable worktree had no diff worker.
      const unwatchable = '/definitely/not/a/real/dir-' + Date.now();
      const closeCalls: unknown[] = [];
      const watchlessWs = asWSContext({
        send: (msg: string) => {
          sentMessages.push(msg);
        },
        close: (...args: unknown[]) => {
          closeCalls.push(args);
        },
        readyState: 1,
      });
      const realHandlers = createGitDiffHandlers({
        getDiffData: mockGetDiffData,
        resolveRef: mockResolveRef,
        resolveBaseSpec: mockResolveBaseSpec,
        startWatching: realStartWatching,
        getFileLines: mock(() => Promise.resolve([])),
        annotationService: new AnnotationService(),
      });

      await realHandlers.handleConnection(watchlessWs, 'session-1', 'worker-unwatchable', unwatchable, 'base-commit', null);

      const messages: GitDiffServerMessage[] = sentMessages.map((m) => JSON.parse(m));
      expect(messages.map((m) => m.type)).toEqual(['diff-data']);
      expect(closeCalls).toEqual([]);
      await realHandlers.handleDisconnection('session-1', 'worker-unwatchable');
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

    it('threads the captured requestUser into resolveBaseSpec / getDiffData (Issue #869)', async () => {
      // A non-null requestUser must reach the underlying service so
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

    it('should stop that connection\'s file watching on disconnection', async () => {
      await handlers.handleConnection(mockWs, 'session-1', 'worker-1', '/repo/path', 'base-commit', null);

      await handlers.handleDisconnection('session-1', 'worker-1', mockWs);

      expect(unsubscribes).toHaveLength(1);
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    });

    it('a disconnection for a socket that is not registered is a no-op', async () => {
      await handlers.handleConnection(mockWs, 'session-1', 'worker-1', '/repo/path', 'base-commit', null);
      const stranger = asWSContext({ send: mock(() => {}), close: mock(), readyState: 1 });

      await handlers.handleDisconnection('session-1', 'worker-1', stranger);

      expect(unsubscribes[0]).not.toHaveBeenCalled();
    });
  });

  // Two tabs on one worker. Reach (each mutation applied alone to git-diff-handler.ts, this file re-run):
  //   a connection map keyed by workerId again -> 'two sockets ... both receive' and 'disconnecting ws1 leaves ws2'
  //   handleDisconnection ignoring `ws` (removing by worker) -> 'disconnecting ws1 leaves ws2' and the stale-close test
  //   updateBaseCommit/sendAnnotationsToClient reaching only one connection -> the two broadcast tests
  describe('two sockets on one worker', () => {
    function makeSocket() {
      const sent: string[] = [];
      const ws = asWSContext({
        send: (msg: string) => {
          sent.push(msg);
        },
        close: mock(),
        readyState: 1,
      });
      return { ws, sent };
    }

    async function connectTwo() {
      const a = makeSocket();
      const b = makeSocket();
      await handlers.handleConnection(a.ws, 'session-1', 'worker-two', '/repo/path', 'base-commit', null);
      await handlers.handleConnection(b.ws, 'session-1', 'worker-two', '/repo/path', 'base-commit', null);
      a.sent.length = 0;
      b.sent.length = 0;
      return { a, b };
    }

    const types = (sent: string[]) => sent.map((m) => (JSON.parse(m) as GitDiffServerMessage).type);

    it('each connection holds its own watch, and a file change reaches both', async () => {
      const { a, b } = await connectTwo();
      expect(mockStartWatching).toHaveBeenCalledTimes(2);

      const onChange = (mockStartWatching.mock.calls as unknown as Array<[string, () => void]>).map((call) => call[1]);
      onChange[0]();
      onChange[1]();
      await Bun.sleep(20);

      expect(types(a.sent)).toEqual(['diff-data']);
      expect(types(b.sent)).toEqual(['diff-data']);
    });

    it('updateBaseCommit reaches every connection of the worker', async () => {
      const { a, b } = await connectTwo();

      await handlers.updateBaseCommit('worker-two', 'main');

      expect(types(a.sent)).toEqual(['diff-data']);
      expect(types(b.sent)).toEqual(['diff-data']);
    });

    it('sendAnnotationsToClient reaches every connection of the worker', async () => {
      const { a, b } = await connectTwo();

      handlers.sendAnnotationsToClient('worker-two', null);

      expect(types(a.sent)).toEqual(['annotations-updated']);
      expect(types(b.sent)).toEqual(['annotations-updated']);
    });

    it('disconnecting ws1 leaves ws2 watching and receiving; a late close of ws1 changes nothing', async () => {
      const { a, b } = await connectTwo();

      await handlers.handleDisconnection('session-1', 'worker-two', a.ws);
      expect(unsubscribes[unsubscribes.length - 2]).toHaveBeenCalledTimes(1);
      expect(unsubscribes[unsubscribes.length - 1]).not.toHaveBeenCalled();

      // the stale-close race: the same socket's close arrives again after it was removed
      await handlers.handleDisconnection('session-1', 'worker-two', a.ws);
      expect(unsubscribes[unsubscribes.length - 1]).not.toHaveBeenCalled();

      await handlers.updateBaseCommit('worker-two', 'main');
      expect(types(a.sent)).toEqual([]);
      expect(types(b.sent)).toEqual(['diff-data']);
    });

    it('a disconnection without a socket (service teardown) stops every connection of the worker', async () => {
      await connectTwo();

      await handlers.handleDisconnection('session-1', 'worker-two');

      expect(unsubscribes[unsubscribes.length - 2]).toHaveBeenCalledTimes(1);
      expect(unsubscribes[unsubscribes.length - 1]).toHaveBeenCalledTimes(1);
    });

    it('a teardown of one worker leaves the connections of another worker on the same path alone', async () => {
      const one = makeSocket();
      const other = makeSocket();
      await handlers.handleConnection(one.ws, 's1', 'worker-x', '/repo/path', 'base-commit', null);
      await handlers.handleConnection(other.ws, 's2', 'worker-y', '/repo/path', 'base-commit', null);
      const [unsubX, unsubY] = unsubscribes.slice(-2);

      await handlers.handleDisconnection('s1', 'worker-x');

      expect(unsubX).toHaveBeenCalledTimes(1);
      expect(unsubY).not.toHaveBeenCalled();
    });

    it('a set-target-commit on ws1 does not change what ws2 shows (state is per connection)', async () => {
      const { a, b } = await connectTwo();

      await handlers.handleMessage(a.ws, 'session-1', 'worker-two', '/repo/path', JSON.stringify({ type: 'set-target-commit', ref: 'main' }));
      const watchChange = (mockStartWatching.mock.calls as unknown as Array<[string, () => void]>).map((call) => call[1]);
      a.sent.length = 0;
      b.sent.length = 0;
      watchChange[0]();
      watchChange[1]();
      await Bun.sleep(20);

      // ws2 is still on the working directory, so its watch refreshes; ws1 moved to a fixed commit, which does not.
      expect(types(a.sent)).toEqual([]);
      expect(types(b.sent)).toEqual(['diff-data']);
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

      it('forwards the captured requestUser into refresh re-resolution and diff (Issue #869)', async () => {
        // File-change / refresh paths must keep using the same requestUser
        // captured at connection time, not silently drop it.
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

      it('threads requestUser into getFileLines for ref-based reads (Issue #869)', async () => {
        // File-line reads at a ref must run as the worktree owner so
        // `git show` does not fail with dubious ownership.
        const getFileLinesMock = mock(() => Promise.resolve(['line1']));
        const deps: GitDiffHandlerDependencies = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          resolveBaseSpec: mockResolveBaseSpec,
          startWatching: mockStartWatching,
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

    it('threads the captured requestUser through updateBaseCommit (Issue #869)', async () => {
      // Server-pushed base-commit updates (e.g. from onDiffBaseCommitChanged)
      // must keep using the same requestUser captured at connection time.
      await connectWorker('original-base', 'workspaceuser');
      mockResolveBaseSpec.mockClear();

      await handlers.updateBaseCommit('worker-1', 'updated-base');

      expect(mockResolveBaseSpec).toHaveBeenCalledWith('updated-base', '/repo/path', 'workspaceuser');
      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'updated-base', 'workspaceuser', 'working-dir');
    });
  });
});
