import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateWorkerRequestSchema,
  RestartWorkerRequestSchema,
} from '../worker';

describe('CreateWorkerRequestSchema', () => {
  // CreateWorkerRequestSchema only accepts terminal workers (client API restriction)

  it('should accept terminal worker', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.type).toBe('terminal');
    }
  });

  it('should accept terminal worker with optional name', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      name: 'My Terminal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('My Terminal');
    }
  });

  it('should accept terminal worker with continueConversation', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      continueConversation: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.continueConversation).toBe(true);
    }
  });

  it('should reject agent worker (not allowed from client)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject git-diff worker (not allowed from client)', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'git-diff',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid type', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing type', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      name: 'My Terminal',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-boolean continueConversation', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      continueConversation: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('should reject number for name field', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
      name: 456,
    });
    expect(result.success).toBe(false);
  });
});

describe('RestartWorkerRequestSchema', () => {
  it('should validate empty request', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {});
    expect(result.success).toBe(true);
  });

  it('should validate with continueConversation true', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.continueConversation).toBe(true);
    }
  });

  it('should validate with continueConversation false', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.continueConversation).toBe(false);
    }
  });

  it('should reject non-boolean continueConversation', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('should validate with valid branch name', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature/new-feature',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/new-feature');
    }
  });

  it('should validate with all fields', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      continueConversation: true,
      agentId: 'agent-123',
      branch: 'feature/test',
    });
    expect(result.success).toBe(true);
  });

  it('should trim whitespace from branch', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: '  feature/test  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.branch).toBe('feature/test');
    }
  });

  it('should reject empty branch name', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only branch name', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('should accept branch with slashes, dots, underscores, hyphens', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature/test-1.0_beta',
    });
    expect(result.success).toBe(true);
  });

  it('should reject branch with spaces', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with special characters', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature@branch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with unicode characters', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature/日本語',
    });
    expect(result.success).toBe(false);
  });

  it('should reject branch with backslash', () => {
    const result = v.safeParse(RestartWorkerRequestSchema, {
      branch: 'feature\\test',
    });
    expect(result.success).toBe(false);
  });
});
