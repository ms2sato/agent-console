import { describe, it, expect } from 'bun:test';
import { WORKER_SERVER_MESSAGE_TYPES, type WorkerServerMessage, type WorkerServerMessageType } from '../session.js';

describe('WORKER_SERVER_MESSAGE_TYPES', () => {
  it('assigns a distinct ordinal to every message type', () => {
    const ordinals = Object.values(WORKER_SERVER_MESSAGE_TYPES);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("includes 'restore-info' at ordinal 9 (Transcript Restore #1123)", () => {
    expect(WORKER_SERVER_MESSAGE_TYPES['restore-info']).toBe(9);
  });

  it("'restore-info' is a valid WorkerServerMessageType key", () => {
    const key: WorkerServerMessageType = 'restore-info';
    expect(WORKER_SERVER_MESSAGE_TYPES[key]).toBe(9);
  });
});

describe('WorkerServerMessage — restore-info variant (Transcript Restore #1123)', () => {
  it('accepts the expected shape', () => {
    const message: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 42,
      messageCount: 5,
      repairedToolCallIds: ['call-1'],
      completed: true,
    };
    expect(message.type).toBe('restore-info');
    if (message.type === 'restore-info') {
      expect(message.epoch).toBe(42);
      expect(message.messageCount).toBe(5);
      expect(message.repairedToolCallIds).toEqual(['call-1']);
      expect(message.completed).toBe(true);
    }
  });

  it('accepts an empty repairedToolCallIds array (no repair needed)', () => {
    const message: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 1,
      messageCount: 0,
      repairedToolCallIds: [],
      completed: false,
    };
    expect(message.repairedToolCallIds).toEqual([]);
  });

  it('distinguishes completed: false (restore delivered, incarnation not yet ready) from completed: true (Issue #1205)', () => {
    const notYetReady: WorkerServerMessage = {
      type: 'restore-info',
      epoch: 7,
      messageCount: 3,
      repairedToolCallIds: [],
      completed: false,
    };
    const ready: WorkerServerMessage = { ...notYetReady, completed: true };
    expect(notYetReady.completed).toBe(false);
    expect(ready.completed).toBe(true);
  });
});
