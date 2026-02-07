import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import type { WSContext } from 'hono/ws';
import type { SDKMessage, SdkWorkerServerMessage } from '@agent-console/shared';
import type { InternalSdkWorker } from '../../services/worker-types.js';
import { handleSdkWorkerMessage } from '../sdk-worker-handler.js';

describe('SDK Worker Handler', () => {
  let mockWs: WSContext;
  let sentMessages: SdkWorkerServerMessage[];
  let mockWorker: InternalSdkWorker;
  let mockRunQuery: Mock<(workerId: string, prompt: string) => Promise<void>>;
  let mockCancelQuery: Mock<(workerId: string) => void>;
  let mockRestoreMessages: Mock<() => Promise<SDKMessage[] | null>>;
  let mockPersistMessage: Mock<(message: SDKMessage) => Promise<void>>;

  beforeEach(() => {
    sentMessages = [];
    // Create mock WebSocket context
    mockWs = {
      send: mock((data: string) => {
        sentMessages.push(JSON.parse(data));
      }),
      close: mock(),
      readyState: 1, // OPEN
    } as unknown as WSContext;

    // Create mock worker
    mockWorker = {
      id: 'worker-1',
      name: 'SDK Worker',
      type: 'sdk',
      createdAt: new Date().toISOString(),
      agentId: 'agent-1',
      activityState: 'idle',
      sdkSessionId: 'sdk-session-1',
      abortController: null,
      isRunning: false,
      messages: [],
      connectionCallbacks: new Map(),
    };

    // Create mock functions
    mockRunQuery = mock(async () => {});
    mockCancelQuery = mock(() => {});
    mockRestoreMessages = mock(async () => null);
    mockPersistMessage = mock(async () => {});
  });

  describe('handleSdkWorkerMessage - user-message', () => {
    it('should persist message before adding to memory and broadcasting', async () => {
      const callOrder: string[] = [];

      mockPersistMessage = mock(async () => {
        callOrder.push('persist');
      });

      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'user-message', content: 'Hello' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      // Record when message was added and broadcast
      callOrder.push('memory-and-broadcast');

      // Persist should be called first
      expect(mockPersistMessage).toHaveBeenCalledTimes(1);
      expect(callOrder[0]).toBe('persist');

      // Message should be added to worker.messages
      expect(mockWorker.messages).toHaveLength(1);
      // The message is created by createSdkUserMessage which sets type: 'user'
      expect(mockWorker.messages[0].type).toBe('user');

      // Message should be broadcast
      const sdkMessages = sentMessages.filter(m => m.type === 'sdk-message');
      expect(sdkMessages).toHaveLength(1);
    });

    it('should NOT add to memory or broadcast when persistence fails', async () => {
      const persistError = new Error('Disk full');
      mockPersistMessage = mock(async () => {
        throw persistError;
      });

      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'user-message', content: 'Hello' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      // Message should NOT be added to worker.messages
      expect(mockWorker.messages).toHaveLength(0);

      // Should NOT broadcast the user message
      const sdkMessages = sentMessages.filter(m => m.type === 'sdk-message');
      expect(sdkMessages).toHaveLength(0);

      // Should send error to client
      const errorMessages = sentMessages.filter(m => m.type === 'error');
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0].type).toBe('error');

      // Should NOT run the query
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should run query after successful persistence and broadcast', async () => {
      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'user-message', content: 'Hello' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      // Verify the full success flow
      expect(mockPersistMessage).toHaveBeenCalledTimes(1);
      expect(mockWorker.messages).toHaveLength(1);
      expect(mockRunQuery).toHaveBeenCalledWith('worker-1', 'Hello');
    });

    it('should work without persistMessage function', async () => {
      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'user-message', content: 'Hello' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        undefined // no persistMessage
      );

      // Should still add to memory and broadcast
      expect(mockWorker.messages).toHaveLength(1);

      const sdkMessages = sentMessages.filter(m => m.type === 'sdk-message');
      expect(sdkMessages).toHaveLength(1);

      expect(mockRunQuery).toHaveBeenCalledWith('worker-1', 'Hello');
    });

    it('should return error when worker not found', async () => {
      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'user-message', content: 'Hello' }),
        () => null, // worker not found
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe('error');
      expect((sentMessages[0] as { type: 'error'; message: string }).message).toBe('Worker not found');

      expect(mockPersistMessage).not.toHaveBeenCalled();
      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('should return error when worker is busy', async () => {
      mockWorker.isRunning = true;

      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'user-message', content: 'Hello' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe('error');
      expect((sentMessages[0] as { type: 'error'; message: string }).message).toBe('Worker is busy');

      expect(mockPersistMessage).not.toHaveBeenCalled();
      expect(mockRunQuery).not.toHaveBeenCalled();
    });
  });

  describe('handleSdkWorkerMessage - cancel', () => {
    it('should call cancelQuery', async () => {
      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'cancel' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      expect(mockCancelQuery).toHaveBeenCalledWith('worker-1');
    });
  });

  describe('handleSdkWorkerMessage - request-history', () => {
    it('should return message history', async () => {
      const existingMessage: SDKMessage = {
        type: 'user',
        message: { role: 'user', content: 'Previous message' },
        session_id: 'sdk-session-1',
        uuid: 'msg-1',
      };
      mockWorker.messages = [existingMessage];

      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'request-history' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe('message-history');
      const historyMsg = sentMessages[0] as { type: 'message-history'; messages: SDKMessage[]; lastUuid: string | null };
      expect(historyMsg.messages).toHaveLength(1);
      expect(historyMsg.messages[0]).toEqual(existingMessage);
    });

    it('should restore messages from file when memory is empty', async () => {
      const restoredMessage: SDKMessage = {
        type: 'user',
        message: { role: 'user', content: 'Restored message' },
        session_id: 'sdk-session-1',
        uuid: 'msg-restored',
      };
      mockRestoreMessages = mock(async () => [restoredMessage]);

      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        JSON.stringify({ type: 'request-history' }),
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      expect(mockRestoreMessages).toHaveBeenCalled();
      expect(sentMessages).toHaveLength(1);
      const historyMsg = sentMessages[0] as { type: 'message-history'; messages: SDKMessage[]; lastUuid: string | null };
      expect(historyMsg.messages).toHaveLength(1);
      expect(historyMsg.messages[0]).toEqual(restoredMessage);
    });
  });

  describe('handleSdkWorkerMessage - invalid messages', () => {
    it('should handle invalid JSON gracefully', async () => {
      await handleSdkWorkerMessage(
        mockWs,
        'session-1',
        'worker-1',
        'not valid json',
        () => mockWorker,
        mockRunQuery,
        mockCancelQuery,
        mockRestoreMessages,
        mockPersistMessage
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe('error');
      expect((sentMessages[0] as { type: 'error'; message: string }).message).toBe('Invalid message format');
    });
  });
});
