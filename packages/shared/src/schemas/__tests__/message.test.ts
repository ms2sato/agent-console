import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import type { WorkerMessage } from '../../types/worker-message';
import {
  SendWorkerMessageRequestSchema,
  WorkerMessageSchema,
  SendWorkerMessageResponseSchema,
} from '../message';

describe('SendWorkerMessageRequestSchema', () => {
  it('should accept a valid request', () => {
    const result = v.safeParse(SendWorkerMessageRequestSchema, {
      toWorkerId: 'worker-1',
      content: 'Hello worker',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.toWorkerId).toBe('worker-1');
      expect(result.output.content).toBe('Hello worker');
    }
  });

  it('should trim whitespace from fields', () => {
    const result = v.safeParse(SendWorkerMessageRequestSchema, {
      toWorkerId: '  worker-1  ',
      content: '  Hello worker  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.toWorkerId).toBe('worker-1');
      expect(result.output.content).toBe('Hello worker');
    }
  });

  it('should reject a missing toWorkerId', () => {
    const result = v.safeParse(SendWorkerMessageRequestSchema, {
      content: 'Hello worker',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an empty toWorkerId', () => {
    const result = v.safeParse(SendWorkerMessageRequestSchema, {
      toWorkerId: '',
      content: 'Hello worker',
    });
    expect(result.success).toBe(false);
  });

  it('should reject content exceeding the max length', () => {
    const result = v.safeParse(SendWorkerMessageRequestSchema, {
      toWorkerId: 'worker-1',
      content: 'a'.repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it('should reject an unknown key (strict-parse contract)', () => {
    const result = v.safeParse(SendWorkerMessageRequestSchema, {
      toWorkerId: 'worker-1',
      content: 'Hello worker',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.some((i) => i.path?.[0]?.key === 'unexpectedField')).toBe(true);
    }
  });
});

// `WorkerMessage` stays a hand-written interface the server imports; this pin fixes the schema's
// output to it exactly. `Assert<Equals<...>>` fails `tsc` (TS2344) under drift in either direction.
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type _WorkerMessageIsExact = Assert<Equals<v.InferOutput<typeof WorkerMessageSchema>, WorkerMessage>>;

const workerMessage: WorkerMessage = {
  id: 'm1',
  sessionId: 's1',
  fromWorkerId: 'w1',
  fromWorkerName: 'Agent',
  toWorkerId: 'w2',
  toWorkerName: 'Shell',
  content: 'hello',
  timestamp: '2026-01-01T00:00:00.000Z',
};

describe('WorkerMessageSchema / SendWorkerMessageResponseSchema', () => {
  it('accepts the real message shape and its envelope', () => {
    expect(v.safeParse(WorkerMessageSchema, workerMessage).success).toBe(true);
    expect(v.safeParse(SendWorkerMessageResponseSchema, { message: workerMessage }).success).toBe(true);
  });

  it('rejects an extra field on the message and on the envelope', () => {
    expect(v.safeParse(WorkerMessageSchema, { ...workerMessage, extra: 1 }).success).toBe(false);
    expect(v.safeParse(SendWorkerMessageResponseSchema, { message: workerMessage, extra: 1 }).success).toBe(false);
  });

  it('rejects a dropped required field', () => {
    const { toWorkerName: _dropped, ...rest } = workerMessage;
    expect(v.safeParse(WorkerMessageSchema, rest).success).toBe(false);
    expect(v.safeParse(SendWorkerMessageResponseSchema, {}).success).toBe(false);
  });
});
