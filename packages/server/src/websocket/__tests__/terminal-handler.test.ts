import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WSContext } from 'hono/ws';
import type { Session } from '@agent-console/shared';

// Mock session manager
vi.mock('../../services/session-manager.js', () => ({
  sessionManager: {
    getSession: vi.fn(),
    getOutputBuffer: vi.fn(() => ''),
    writeInput: vi.fn(),
    resize: vi.fn(),
    createSession: vi.fn(),
    attachCallbacks: vi.fn(),
  },
}));

// Mock fs for image handling tests
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('Terminal Handler', () => {
  let mockWs: WSContext;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Create mock WebSocket context
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1, // OPEN
    } as unknown as WSContext;
  });

  describe('handleTerminalConnection', () => {
    it('should send exit message and close when session not found', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      vi.mocked(sessionManager.getSession).mockReturnValue(undefined);

      const { handleTerminalConnection } = await import('../terminal-handler.js');
      handleTerminalConnection(mockWs, 'non-existent');

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'exit', exitCode: 1, signal: null })
      );
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should send history when session exists and has buffered output', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      const mockSession: Session = {
        id: 'test-session',
        worktreePath: '/test/path',
        repositoryId: 'repo-1',
        status: 'running',
        pid: 12345,
        startedAt: '2024-01-01T00:00:00.000Z',
        activityState: 'idle',
      };
      vi.mocked(sessionManager.getSession).mockReturnValue(mockSession);
      vi.mocked(sessionManager.getOutputBuffer).mockReturnValue('previous output');

      const { handleTerminalConnection } = await import('../terminal-handler.js');
      handleTerminalConnection(mockWs, 'test-session');

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'history', data: 'previous output' })
      );
      expect(mockWs.close).not.toHaveBeenCalled();
    });

    it('should send activity state on connection', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      const mockSession: Session = {
        id: 'test-session',
        worktreePath: '/test/path',
        repositoryId: 'repo-1',
        status: 'running',
        pid: 12345,
        startedAt: '2024-01-01T00:00:00.000Z',
        activityState: 'active',
      };
      vi.mocked(sessionManager.getSession).mockReturnValue(mockSession);
      vi.mocked(sessionManager.getOutputBuffer).mockReturnValue('');

      const { handleTerminalConnection } = await import('../terminal-handler.js');
      handleTerminalConnection(mockWs, 'test-session');

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'activity', state: 'active' })
      );
    });

    it('should default to idle when activityState is undefined', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      const mockSession: Session = {
        id: 'test-session',
        worktreePath: '/test/path',
        repositoryId: 'repo-1',
        status: 'running',
        pid: 12345,
        startedAt: '2024-01-01T00:00:00.000Z',
        // activityState is undefined
      };
      vi.mocked(sessionManager.getSession).mockReturnValue(mockSession);
      vi.mocked(sessionManager.getOutputBuffer).mockReturnValue('');

      const { handleTerminalConnection } = await import('../terminal-handler.js');
      handleTerminalConnection(mockWs, 'test-session');

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'activity', state: 'idle' })
      );
    });

    it('should not send history when buffer is empty', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      const mockSession: Session = {
        id: 'test-session',
        worktreePath: '/test/path',
        repositoryId: 'repo-1',
        status: 'running',
        pid: 12345,
        startedAt: '2024-01-01T00:00:00.000Z',
        activityState: 'idle',
      };
      vi.mocked(sessionManager.getSession).mockReturnValue(mockSession);
      vi.mocked(sessionManager.getOutputBuffer).mockReturnValue('');

      const { handleTerminalConnection } = await import('../terminal-handler.js');
      handleTerminalConnection(mockWs, 'test-session');

      // Should send activity but not history
      expect(mockWs.send).toHaveBeenCalledTimes(1);
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'activity', state: 'idle' })
      );
    });
  });

  describe('handleTerminalMessage', () => {
    it('should handle input message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      const message = JSON.stringify({ type: 'input', data: 'hello world' });
      handleTerminalMessage(mockWs, 'test-session', message);

      expect(sessionManager.writeInput).toHaveBeenCalledWith('test-session', 'hello world');
    });

    it('should handle resize message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      const message = JSON.stringify({ type: 'resize', cols: 80, rows: 24 });
      handleTerminalMessage(mockWs, 'test-session', message);

      expect(sessionManager.resize).toHaveBeenCalledWith('test-session', 80, 24);
    });

    it('should handle image message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const fs = await import('node:fs');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      // Base64 encoded small PNG
      const base64Image = 'iVBORw0KGgo='; // minimal base64 data
      const message = JSON.stringify({
        type: 'image',
        data: base64Image,
        mimeType: 'image/png',
      });

      handleTerminalMessage(mockWs, 'test-session', message);

      // Should write file
      expect(fs.writeFileSync).toHaveBeenCalled();

      // Should write file path to session
      expect(sessionManager.writeInput).toHaveBeenCalled();
      const writtenPath = vi.mocked(sessionManager.writeInput).mock.calls[0][1];
      expect(writtenPath).toContain('.png');
    });

    it('should handle ArrayBuffer message', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      const message = new TextEncoder().encode(
        JSON.stringify({ type: 'input', data: 'test' })
      ).buffer;
      handleTerminalMessage(mockWs, 'test-session', message);

      expect(sessionManager.writeInput).toHaveBeenCalledWith('test-session', 'test');
    });

    it('should handle invalid JSON gracefully', async () => {
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      // Should not throw
      expect(() => {
        handleTerminalMessage(mockWs, 'test-session', 'not valid json');
      }).not.toThrow();
    });

    it('should handle unknown message type gracefully', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      const message = JSON.stringify({ type: 'unknown', data: 'test' });
      handleTerminalMessage(mockWs, 'test-session', message);

      // Should not call any methods
      expect(sessionManager.writeInput).not.toHaveBeenCalled();
      expect(sessionManager.resize).not.toHaveBeenCalled();
    });
  });

  describe('createSessionWithWebSocket', () => {
    it('should create session and return session id', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      vi.mocked(sessionManager.createSession).mockReturnValue({
        id: 'new-session-id',
        worktreePath: '/path',
        repositoryId: 'repo',
        status: 'running',
        pid: 1234,
        startedAt: '2024-01-01T00:00:00.000Z',
        activityState: 'idle',
      });

      const { createSessionWithWebSocket } = await import('../terminal-handler.js');
      const sessionId = createSessionWithWebSocket(mockWs, '/path', 'repo');

      expect(sessionId).toBe('new-session-id');
      expect(sessionManager.createSession).toHaveBeenCalledWith(
        '/path',
        'repo',
        expect.any(Function), // onData
        expect.any(Function) // onExit
      );
    });

    it('should send output messages through WebSocket', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      let capturedOnData: ((data: string) => void) | null = null;
      vi.mocked(sessionManager.createSession).mockImplementation(
        (path, repoId, onData, _onExit) => {
          capturedOnData = onData;
          return {
            id: 'test-session',
            worktreePath: path,
            repositoryId: repoId,
            status: 'running',
            pid: 1234,
            startedAt: '2024-01-01T00:00:00.000Z',
            activityState: 'idle',
          };
        }
      );

      const { createSessionWithWebSocket } = await import('../terminal-handler.js');
      createSessionWithWebSocket(mockWs, '/path', 'repo');

      // Trigger onData callback
      capturedOnData!('test output');

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'output', data: 'test output' })
      );
    });

    it('should send exit messages through WebSocket', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      let capturedOnExit: ((exitCode: number, signal: string | null) => void) | null = null;
      vi.mocked(sessionManager.createSession).mockImplementation(
        (path, repoId, _onData, onExit) => {
          capturedOnExit = onExit;
          return {
            id: 'test-session',
            worktreePath: path,
            repositoryId: repoId,
            status: 'running',
            pid: 1234,
            startedAt: '2024-01-01T00:00:00.000Z',
            activityState: 'idle',
          };
        }
      );

      const { createSessionWithWebSocket } = await import('../terminal-handler.js');
      createSessionWithWebSocket(mockWs, '/path', 'repo');

      // Trigger onExit callback
      capturedOnExit!(0, null);

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'exit', exitCode: 0, signal: null })
      );
    });
  });

  describe('getExtensionFromMimeType (via image handling)', () => {
    it('should use correct extension for different mime types', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      const testCases = [
        { mimeType: 'image/png', expectedExt: '.png' },
        { mimeType: 'image/jpeg', expectedExt: '.jpg' },
        { mimeType: 'image/gif', expectedExt: '.gif' },
        { mimeType: 'image/webp', expectedExt: '.webp' },
        { mimeType: 'image/bmp', expectedExt: '.bmp' },
      ];

      for (const { mimeType, expectedExt } of testCases) {
        vi.mocked(sessionManager.writeInput).mockClear();

        const message = JSON.stringify({
          type: 'image',
          data: 'dGVzdA==', // base64 for "test"
          mimeType,
        });
        handleTerminalMessage(mockWs, 'test-session', message);

        const writtenPath = vi.mocked(sessionManager.writeInput).mock.calls[0][1];
        expect(writtenPath).toContain(expectedExt);
      }
    });

    it('should fallback to png for unknown mime type', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');
      const { handleTerminalMessage } = await import('../terminal-handler.js');

      const message = JSON.stringify({
        type: 'image',
        data: 'dGVzdA==',
        mimeType: 'image/unknown',
      });
      handleTerminalMessage(mockWs, 'test-session', message);

      const writtenPath = vi.mocked(sessionManager.writeInput).mock.calls[0][1];
      expect(writtenPath).toContain('.png');
    });
  });

  describe('createSessionWithWebSocket error handling', () => {
    it('should handle exit with signal', async () => {
      const { sessionManager } = await import('../../services/session-manager.js');

      let capturedOnExit: ((exitCode: number, signal: string | null) => void) | null = null;
      vi.mocked(sessionManager.createSession).mockImplementation(
        (path, repoId, _onData, onExit) => {
          capturedOnExit = onExit;
          return {
            id: 'test-session',
            worktreePath: path,
            repositoryId: repoId,
            status: 'running',
            pid: 1234,
            startedAt: '2024-01-01T00:00:00.000Z',
            activityState: 'idle',
          };
        }
      );

      const { createSessionWithWebSocket } = await import('../terminal-handler.js');
      createSessionWithWebSocket(mockWs, '/path', 'repo');

      // Trigger onExit callback with signal
      capturedOnExit!(1, 'SIGTERM');

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'exit', exitCode: 1, signal: 'SIGTERM' })
      );
    });
  });
});
