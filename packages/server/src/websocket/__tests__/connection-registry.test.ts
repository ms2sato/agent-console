import { describe, it, expect, beforeEach } from 'bun:test';
import type { WSContext } from 'hono/ws';
import { WebSocketConnectionRegistry } from '../connection-registry.js';

function createMockWs(): WSContext {
  return {
    send: () => {},
    close: () => {},
    readyState: 1,
  } as unknown as WSContext;
}

describe('WebSocketConnectionRegistry', () => {
  let registry: WebSocketConnectionRegistry;

  beforeEach(() => {
    registry = new WebSocketConnectionRegistry();
  });

  describe('app client management', () => {
    it('should add and track app clients', () => {
      const ws = createMockWs();
      registry.addAppClient(ws);
      expect(registry.appClientCount).toBe(1);
      expect(registry.getAppClients().has(ws)).toBe(true);
    });

    it('should remove app clients and clean up syncing state', () => {
      const ws = createMockWs();
      registry.addAppClient(ws);
      registry.startSyncing(ws);

      registry.removeAppClient(ws);
      expect(registry.appClientCount).toBe(0);
      expect(registry.isSyncing(ws)).toBe(false);
      expect(registry.getSyncQueue(ws)).toBeUndefined();
    });
  });

  describe('syncing state management', () => {
    it('should track syncing state and create queue', () => {
      const ws = createMockWs();
      registry.startSyncing(ws);
      expect(registry.isSyncing(ws)).toBe(true);
      expect(registry.getSyncQueue(ws)).toEqual([]);
    });

    it('should queue messages for syncing clients', () => {
      const ws = createMockWs();
      registry.startSyncing(ws);

      const msg = { type: 'session-created' as const, session: {} as any };
      const result = registry.queueSyncMessage(ws, msg);
      expect(result).toBe('queued');
      expect(registry.getSyncQueue(ws)).toHaveLength(1);
    });

    it('should return overflow when queue exceeds limit', () => {
      const ws = createMockWs();
      registry.startSyncing(ws);

      // Fill queue to capacity (MAX_SYNC_QUEUE_SIZE = 100)
      for (let i = 0; i < 100; i++) {
        registry.queueSyncMessage(ws, { type: 'session-deleted' as const, sessionId: `s${i}` });
      }

      const result = registry.queueSyncMessage(ws, { type: 'session-deleted' as const, sessionId: 'overflow' });
      expect(result).toBe('overflow');
    });

    it('should return overflow when client has no queue', () => {
      const ws = createMockWs();
      // Not syncing, so no queue exists
      const result = registry.queueSyncMessage(ws, { type: 'session-deleted' as const, sessionId: 'test' });
      expect(result).toBe('overflow');
    });

    it('should clean up syncing state on stopSyncing', () => {
      const ws = createMockWs();
      registry.startSyncing(ws);
      registry.queueSyncMessage(ws, { type: 'session-deleted' as const, sessionId: 'test' });

      registry.stopSyncing(ws);
      expect(registry.isSyncing(ws)).toBe(false);
      expect(registry.getSyncQueue(ws)).toBeUndefined();
    });
  });

  describe('worker connection management', () => {
    it('should add worker connections by session and worker', () => {
      const ws = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws);

      expect(registry.getWorkerConnectionsBySession('session-1')?.has(ws)).toBe(true);
      expect(registry.getWorkerConnections('session-1', 'worker-1')?.has(ws)).toBe(true);
    });

    it('should track multiple connections per session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws1);
      registry.addWorkerConnection('session-1', 'worker-2', ws2);

      const sessionConns = registry.getWorkerConnectionsBySession('session-1');
      expect(sessionConns?.size).toBe(2);
    });

    it('should remove worker connections and clean up empty sets', () => {
      const ws = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws);

      registry.removeWorkerConnection('session-1', 'worker-1', ws);
      expect(registry.getWorkerConnectionsBySession('session-1')).toBeUndefined();
      expect(registry.getWorkerConnections('session-1', 'worker-1')).toBeUndefined();
    });

    it('should not remove session entry when other connections remain', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws1);
      registry.addWorkerConnection('session-1', 'worker-2', ws2);

      registry.removeWorkerConnection('session-1', 'worker-1', ws1);
      expect(registry.getWorkerConnectionsBySession('session-1')?.size).toBe(1);
      expect(registry.getWorkerConnectionsBySession('session-1')?.has(ws2)).toBe(true);
    });

    it('should remove all session connections including per-worker and metadata entries', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws1);
      registry.addWorkerConnection('session-1', 'worker-2', ws2);
      registry.setConnectionMetadata(ws1, { sessionId: 'session-1', workerId: 'worker-1', connectionId: 'conn-1' });
      registry.setConnectionMetadata(ws2, { sessionId: 'session-1', workerId: 'worker-2', connectionId: 'conn-2' });

      registry.removeSessionConnections('session-1');

      // All session-level tracking should be removed
      expect(registry.getWorkerConnectionsBySession('session-1')).toBeUndefined();
      // Per-worker connections should also be cleaned up
      expect(registry.getWorkerConnections('session-1', 'worker-1')).toBeUndefined();
      expect(registry.getWorkerConnections('session-1', 'worker-2')).toBeUndefined();
      // Connection metadata should be cleaned up
      expect(registry.getConnectionMetadata(ws1)).toBeUndefined();
      expect(registry.getConnectionMetadata(ws2)).toBeUndefined();
    });

    it('should not affect other sessions when removing one session connections', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws1);
      registry.addWorkerConnection('session-2', 'worker-1', ws2);
      registry.setConnectionMetadata(ws1, { sessionId: 'session-1', workerId: 'worker-1', connectionId: 'conn-1' });
      registry.setConnectionMetadata(ws2, { sessionId: 'session-2', workerId: 'worker-1', connectionId: 'conn-2' });

      registry.removeSessionConnections('session-1');

      // Session 1 should be fully cleaned up
      expect(registry.getWorkerConnectionsBySession('session-1')).toBeUndefined();
      expect(registry.getWorkerConnections('session-1', 'worker-1')).toBeUndefined();
      expect(registry.getConnectionMetadata(ws1)).toBeUndefined();

      // Session 2 should be unaffected
      expect(registry.getWorkerConnectionsBySession('session-2')?.has(ws2)).toBe(true);
      expect(registry.getWorkerConnections('session-2', 'worker-1')?.has(ws2)).toBe(true);
      expect(registry.getConnectionMetadata(ws2)).toEqual({ sessionId: 'session-2', workerId: 'worker-1', connectionId: 'conn-2' });
    });

    it('should clean up connections even without connectionMetadata', () => {
      const ws = createMockWs();
      registry.addWorkerConnection('session-1', 'worker-1', ws);
      // Intentionally do NOT call setConnectionMetadata

      // Verify connection exists
      expect(registry.getWorkerConnections('session-1', 'worker-1')?.has(ws)).toBe(true);

      // Remove all session connections
      registry.removeSessionConnections('session-1');

      // Verify cleanup completed
      expect(registry.getWorkerConnections('session-1', 'worker-1')).toBeUndefined();
      expect(registry.getWorkerConnectionsBySession('session-1')).toBeUndefined();
    });

    it('should return undefined for non-existent session connections', () => {
      expect(registry.getWorkerConnectionsBySession('non-existent')).toBeUndefined();
      expect(registry.getWorkerConnections('non-existent', 'worker')).toBeUndefined();
    });
  });

  describe('connection metadata management', () => {
    it('should store and retrieve connection metadata', () => {
      const ws = createMockWs();
      const metadata = { sessionId: 'session-1', workerId: 'worker-1', connectionId: 'conn-1' };

      registry.setConnectionMetadata(ws, metadata);
      expect(registry.getConnectionMetadata(ws)).toEqual(metadata);
    });

    it('should remove connection metadata', () => {
      const ws = createMockWs();
      registry.setConnectionMetadata(ws, { sessionId: 's', workerId: 'w', connectionId: 'c' });

      registry.removeConnectionMetadata(ws);
      expect(registry.getConnectionMetadata(ws)).toBeUndefined();
    });

    it('should return undefined for non-existent metadata', () => {
      const ws = createMockWs();
      expect(registry.getConnectionMetadata(ws)).toBeUndefined();
    });
  });
});
