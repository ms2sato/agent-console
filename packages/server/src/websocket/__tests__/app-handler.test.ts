import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import {
  isValidClientMessage,
  buildSessionsSyncMessage,
  sendSessionsSync,
  createAppMessageHandler,
  type AppHandlerDependencies,
} from '../app-handler.js';
import type { Session, AgentActivityState } from '@agent-console/shared';

describe('App Handler', () => {
  describe('isValidClientMessage', () => {
    it('should return true for valid request-sync message', () => {
      expect(isValidClientMessage({ type: 'request-sync' })).toBe(true);
    });

    it('should return false for null', () => {
      expect(isValidClientMessage(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isValidClientMessage('string')).toBe(false);
      expect(isValidClientMessage(123)).toBe(false);
      expect(isValidClientMessage(undefined)).toBe(false);
    });

    it('should return false for object without type', () => {
      expect(isValidClientMessage({})).toBe(false);
      expect(isValidClientMessage({ data: 'test' })).toBe(false);
    });

    it('should return false for invalid message type', () => {
      expect(isValidClientMessage({ type: 'invalid-type' })).toBe(false);
      expect(isValidClientMessage({ type: 'sessions-sync' })).toBe(false); // server message, not client
    });

    it('should return false for non-string type', () => {
      expect(isValidClientMessage({ type: 123 })).toBe(false);
      expect(isValidClientMessage({ type: null })).toBe(false);
    });
  });

  describe('buildSessionsSyncMessage', () => {
    it('should build message with empty sessions', () => {
      const deps = {
        getAllSessions: () => [],
        getWorkerActivityState: () => undefined,
      };

      const msg = buildSessionsSyncMessage(deps);

      expect(msg.type).toBe('sessions-sync');
      expect(msg.sessions).toEqual([]);
      expect(msg.activityStates).toEqual([]);
    });

    it('should build message with sessions and activity states', () => {
      const sessions: Session[] = [
        {
          id: 'session-1',
          type: 'quick',
          locationPath: '/path/1',
          status: 'active',
          createdAt: '2024-01-01',
          workers: [
            { id: 'worker-1', type: 'agent', agentId: 'claude', name: 'Agent 1', createdAt: '2024-01-01' },
            { id: 'worker-2', type: 'terminal', name: 'Terminal 1', createdAt: '2024-01-01' },
          ],
        },
        {
          id: 'session-2',
          type: 'quick',
          locationPath: '/path/2',
          status: 'active',
          createdAt: '2024-01-01',
          workers: [
            { id: 'worker-3', type: 'agent', agentId: 'claude', name: 'Agent 2', createdAt: '2024-01-01' },
          ],
        },
      ];

      const deps = {
        getAllSessions: () => sessions,
        getWorkerActivityState: (sessionId: string, workerId: string): AgentActivityState | undefined => {
          if (sessionId === 'session-1' && workerId === 'worker-1') return 'active';
          if (sessionId === 'session-2' && workerId === 'worker-3') return 'idle';
          return undefined;
        },
      };

      const msg = buildSessionsSyncMessage(deps);

      expect(msg.type).toBe('sessions-sync');
      expect(msg.sessions).toEqual(sessions);
      expect(msg.activityStates).toHaveLength(2);
      expect(msg.activityStates).toContainEqual({
        sessionId: 'session-1',
        workerId: 'worker-1',
        activityState: 'active',
      });
      expect(msg.activityStates).toContainEqual({
        sessionId: 'session-2',
        workerId: 'worker-3',
        activityState: 'idle',
      });
    });

    it('should skip terminal workers', () => {
      const sessions: Session[] = [
        {
          id: 'session-1',
          type: 'quick',
          locationPath: '/path/1',
          status: 'active',
          createdAt: '2024-01-01',
          workers: [
            { id: 'worker-1', type: 'terminal', name: 'Terminal', createdAt: '2024-01-01' },
          ],
        },
      ];

      const deps = {
        getAllSessions: () => sessions,
        getWorkerActivityState: (): AgentActivityState | undefined => 'active',
      };

      const msg = buildSessionsSyncMessage(deps);

      expect(msg.activityStates).toEqual([]);
    });

    it('should skip workers with undefined activity state', () => {
      const sessions: Session[] = [
        {
          id: 'session-1',
          type: 'quick',
          locationPath: '/path/1',
          status: 'active',
          createdAt: '2024-01-01',
          workers: [
            { id: 'worker-1', type: 'agent', agentId: 'claude', name: 'Agent', createdAt: '2024-01-01' },
          ],
        },
      ];

      const deps = {
        getAllSessions: () => sessions,
        getWorkerActivityState: (): AgentActivityState | undefined => undefined,
      };

      const msg = buildSessionsSyncMessage(deps);

      expect(msg.activityStates).toEqual([]);
    });
  });

  describe('sendSessionsSync', () => {
    it('should send sessions-sync message to WebSocket', () => {
      const mockWs = {
        send: mock(),
      } as unknown as WSContext;

      const deps = {
        getAllSessions: () => [],
        getWorkerActivityState: () => undefined,
        logger: { debug: mock(), warn: mock(), error: mock() },
      };

      sendSessionsSync(mockWs, deps);

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sentData = JSON.parse((mockWs.send as ReturnType<typeof mock>).mock.calls[0][0]);
      expect(sentData.type).toBe('sessions-sync');
      expect(sentData.sessions).toEqual([]);
      expect(sentData.activityStates).toEqual([]);
    });

    it('should log session count', () => {
      const mockWs = { send: mock() } as unknown as WSContext;
      const mockDebug = mock();

      const deps = {
        getAllSessions: () => [
          { id: '1', type: 'quick', locationPath: '/', status: 'active', createdAt: '', workers: [] },
          { id: '2', type: 'quick', locationPath: '/', status: 'active', createdAt: '', workers: [] },
        ] as Session[],
        getWorkerActivityState: () => undefined,
        logger: { debug: mockDebug, warn: mock(), error: mock() },
      };

      sendSessionsSync(mockWs, deps);

      expect(mockDebug).toHaveBeenCalledWith({ sessionCount: 2 }, 'Sent sessions-sync');
    });
  });

  describe('createAppMessageHandler', () => {
    let mockWs: WSContext;
    let mockDeps: AppHandlerDependencies;

    beforeEach(() => {
      mockWs = {
        send: mock(),
      } as unknown as WSContext;

      mockDeps = {
        getAllSessions: () => [],
        getWorkerActivityState: () => undefined,
        getAllAgents: async () => [],
        getAllRepositories: () => [],
        logger: { debug: mock(), warn: mock(), error: mock() },
      };
    });

    it('should handle request-sync message', async () => {
      const handler = createAppMessageHandler(mockDeps);
      const message = JSON.stringify({ type: 'request-sync' });

      handler(mockWs, message);

      // Wait for async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should send sessions-sync (sync), agents-sync (async), and repositories-sync (async)
      expect(mockWs.send).toHaveBeenCalledTimes(3);

      const sentMessages = (mockWs.send as ReturnType<typeof mock>).mock.calls.map(
        (call) => JSON.parse(call[0] as string)
      );
      const messageTypes = sentMessages.map((m: { type: string }) => m.type);

      expect(messageTypes).toContain('sessions-sync');
      expect(messageTypes).toContain('agents-sync');
      expect(messageTypes).toContain('repositories-sync');
    });

    it('should handle ArrayBuffer message', async () => {
      const handler = createAppMessageHandler(mockDeps);
      const message = new TextEncoder().encode(JSON.stringify({ type: 'request-sync' })).buffer;

      handler(mockWs, message);

      // Wait for async operations to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should send all three sync messages
      expect(mockWs.send).toHaveBeenCalledTimes(3);
    });

    it('should log and ignore invalid message type', () => {
      const handler = createAppMessageHandler(mockDeps);
      const message = JSON.stringify({ type: 'invalid-type' });

      handler(mockWs, message);

      expect(mockWs.send).not.toHaveBeenCalled();
      expect(mockDeps.logger.warn).toHaveBeenCalledWith(
        { data: message },
        'Invalid app client message'
      );
    });

    it('should log and ignore malformed JSON', () => {
      const handler = createAppMessageHandler(mockDeps);
      const message = 'not valid json';

      handler(mockWs, message);

      expect(mockWs.send).not.toHaveBeenCalled();
      expect(mockDeps.logger.warn).toHaveBeenCalled();
      const warnCall = (mockDeps.logger.warn as ReturnType<typeof mock>).mock.calls[0];
      expect(warnCall[0]).toHaveProperty('err');
      expect(warnCall[0]).toHaveProperty('data', message);
      expect(warnCall[1]).toBe('Failed to parse app client message');
    });

    it('should log debug message when handling request-sync', () => {
      const handler = createAppMessageHandler(mockDeps);
      const message = JSON.stringify({ type: 'request-sync' });

      handler(mockWs, message);

      expect(mockDeps.logger.debug).toHaveBeenCalledWith(
        {},
        'Received request-sync, sending full sync'
      );
    });
  });
});
