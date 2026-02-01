import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import type { GitDiffData, GitDiffServerMessage } from '@agent-console/shared';
import { createGitDiffHandlers, type GitDiffHandlerDependencies } from '../git-diff-handler.js';


describe('GitDiffHandler', () => {
  let mockWs: WSContext;
  let sentMessages: string[];
  let mockGetDiffData: ReturnType<typeof mock>;
  let mockResolveRef: ReturnType<typeof mock>;
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

    // Create mock dependencies
    mockGetDiffData = mock(async () => mockDiffData);
    mockResolveRef = mock(async (ref: string) => {
      if (ref === 'main' || ref === 'HEAD') {
        return 'resolved-commit-hash';
      }
      return null;
    });
    mockStartWatching = mock(() => {});
    mockStopWatching = mock(() => {});

    const deps: GitDiffHandlerDependencies = {
      getDiffData: mockGetDiffData,
      resolveRef: mockResolveRef,
      startWatching: mockStartWatching,
      stopWatching: mockStopWatching,
      getFileLines: mock(() => Promise.resolve([])),
    };

    handlers = createGitDiffHandlers(deps);
  });

  /** Helper to establish a connection before sending messages */
  async function connectWorker(baseCommit: string = 'base-commit'): Promise<void> {
    await handlers.handleConnection(mockWs, 'session-1', 'worker-1', '/repo/path', baseCommit);
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
        'base-commit'
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
        'specific-commit'
      );

      expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'specific-commit', 'working-dir');
    });

    it('should start file watching on connection', async () => {
      await handlers.handleConnection(
        mockWs,
        'session-1',
        'worker-1',
        '/repo/path',
        'base-commit'
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
        'base-commit'
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
        'base-commit'
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

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'current-base', 'working-dir');
        expect(sentMessages.length).toBe(1);

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });
    });

    describe('set-base-commit message', () => {
      it('should resolve ref and send diff data for valid ref', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'main' }));

        expect(mockResolveRef).toHaveBeenCalledWith('main', '/repo/path');
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', 'working-dir');

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });

      it('should send error for invalid ref', async () => {
        await connectWorker('old-base');

        await sendMessage(JSON.stringify({ type: 'set-base-commit', ref: 'invalid-branch' }));

        expect(mockResolveRef).toHaveBeenCalledWith('invalid-branch', '/repo/path');
        expect(mockGetDiffData).not.toHaveBeenCalled();

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect((sentMsg as { error: string }).error).toContain('Invalid ref');
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

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', 'working-dir');
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

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', 'resolved-commit-hash');
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
          'base-commit'
        );
        sentMessages = [];

        const deps = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: mock(() => Promise.resolve(['line1', 'line2', 'line3'])),
        } satisfies GitDiffHandlerDependencies;
        const localHandlers = createGitDiffHandlers(deps);

        // Need to connect first to set up state
        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-2',
          '/repo/path',
          'base-commit'
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

      it('sends error for path traversal attempt', async () => {
        const deps: GitDiffHandlerDependencies = {
          getDiffData: mockGetDiffData,
          resolveRef: mockResolveRef,
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: mock(() => Promise.reject(new Error('Invalid file path: ../etc/passwd'))),
        };
        const localHandlers = createGitDiffHandlers(deps);

        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-traversal',
          '/repo/path',
          'base-commit'
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
          startWatching: mockStartWatching,
          stopWatching: mockStopWatching,
          getFileLines: mock(() => Promise.reject(new Error('File not found'))),
        };
        const localHandlers = createGitDiffHandlers(deps);

        await localHandlers.handleConnection(
          mockWs,
          'session-1',
          'worker-3',
          '/repo/path',
          'base-commit'
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
});
