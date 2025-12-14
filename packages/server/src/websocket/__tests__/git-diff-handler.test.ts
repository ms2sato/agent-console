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
    };

    handlers = createGitDiffHandlers(deps);
  });

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
    describe('refresh message', () => {
      it('should send updated diff data on refresh', async () => {
        // First establish a connection to set up connection state
        await handlers.handleConnection(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'current-base'
        );
        sentMessages = []; // Clear connection message
        mockGetDiffData.mockClear();

        const message = JSON.stringify({ type: 'refresh' });

        await handlers.handleMessage(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'current-base',
          message
        );

        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'current-base', 'working-dir');
        expect(sentMessages.length).toBe(1);

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });
    });

    describe('set-base-commit message', () => {
      it('should resolve ref and send diff data for valid ref', async () => {
        // First establish a connection to set up connection state
        await handlers.handleConnection(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'old-base'
        );
        sentMessages = []; // Clear connection message
        mockGetDiffData.mockClear();

        const message = JSON.stringify({ type: 'set-base-commit', ref: 'main' });

        await handlers.handleMessage(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'old-base',
          message
        );

        expect(mockResolveRef).toHaveBeenCalledWith('main', '/repo/path');
        expect(mockGetDiffData).toHaveBeenCalledWith('/repo/path', 'resolved-commit-hash', 'working-dir');

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-data');
      });

      it('should send error for invalid ref', async () => {
        const message = JSON.stringify({ type: 'set-base-commit', ref: 'invalid-branch' });

        await handlers.handleMessage(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'old-base',
          message
        );

        expect(mockResolveRef).toHaveBeenCalledWith('invalid-branch', '/repo/path');
        expect(mockGetDiffData).not.toHaveBeenCalled();

        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect(sentMsg).toHaveProperty('error');
        expect((sentMsg as { error: string }).error).toContain('Invalid ref');
      });
    });

    describe('invalid message', () => {
      it('should send error for invalid JSON', async () => {
        await handlers.handleMessage(
          mockWs,
          'session-1',
          'worker-1',
          '/repo/path',
          'base',
          'not valid json'
        );

        expect(sentMessages.length).toBe(1);
        const sentMsg: GitDiffServerMessage = JSON.parse(sentMessages[0]);
        expect(sentMsg.type).toBe('diff-error');
        expect(sentMsg).toHaveProperty('error', 'Invalid message format');
      });
    });
  });
});
