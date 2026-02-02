import { describe, it, expect } from 'bun:test';
import { MessageService } from '../message-service.js';
import type { WorkerMessage } from '@agent-console/shared';

function createMessage(overrides: Partial<WorkerMessage> = {}): WorkerMessage {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    fromWorkerId: 'worker-a',
    fromWorkerName: 'Agent A',
    toWorkerId: 'worker-b',
    toWorkerName: 'Agent B',
    content: 'hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('MessageService', () => {
  it('stores and retrieves messages by session', () => {
    const service = new MessageService();
    const msg = createMessage();
    service.addMessage(msg);
    expect(service.getMessages('session-1')).toEqual([msg]);
  });

  it('returns empty array for unknown session', () => {
    const service = new MessageService();
    expect(service.getMessages('unknown')).toEqual([]);
  });

  it('clears messages for a session', () => {
    const service = new MessageService();
    service.addMessage(createMessage());
    service.clearSession('session-1');
    expect(service.getMessages('session-1')).toEqual([]);
  });

  it('trims old messages beyond max limit', () => {
    const service = new MessageService();
    // Add 210 messages
    for (let i = 0; i < 210; i++) {
      service.addMessage(createMessage({ id: `msg-${i}` }));
    }
    const messages = service.getMessages('session-1');
    expect(messages.length).toBe(200);
    // First message should be msg-10 (oldest 10 trimmed)
    expect(messages[0].id).toBe('msg-10');
  });

  it('isolates messages between sessions', () => {
    const service = new MessageService();
    service.addMessage(createMessage({ sessionId: 'session-1' }));
    service.addMessage(createMessage({ sessionId: 'session-2' }));
    expect(service.getMessages('session-1').length).toBe(1);
    expect(service.getMessages('session-2').length).toBe(1);
  });
});
