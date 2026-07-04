import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { SendWorkerMessageRequestSchema } from '../message';

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
