import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  CreateWorkerRequestSchema,
  CreateAgentWorkerRequestSchema,
  CreateTerminalWorkerRequestSchema,
  RestartWorkerRequestSchema,
} from '../worker';

describe('CreateAgentWorkerRequestSchema', () => {
  it('should validate valid agent worker request', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.type).toBe('agent');
      expect(result.output.agentId).toBe('agent-123');
    }
  });

  it('should validate with optional name', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      name: 'My Agent Worker',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('My Agent Worker');
    }
  });

  it('should reject missing agentId', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty agentId', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject wrong type', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'terminal',
      agentId: 'agent-123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing type', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      agentId: 'agent-123',
    });
    expect(result.success).toBe(false);
  });

  // Type mismatch tests
  it('should reject number for agentId field', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 123,
    });
    expect(result.success).toBe(false);
  });

  it('should reject object for agentId field', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: { id: 'agent-123' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject null for agentId field', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: null,
    });
    expect(result.success).toBe(false);
  });

  it('should reject number for name field', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      name: 456,
    });
    expect(result.success).toBe(false);
  });

  // Optional field tests
  it('should accept undefined name', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      name: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('should accept continueConversation option', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      continueConversation: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.continueConversation).toBe(true);
    }
  });

  it('should reject non-boolean continueConversation', () => {
    const result = v.safeParse(CreateAgentWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
      continueConversation: 'yes',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateTerminalWorkerRequestSchema', () => {
  it('should validate valid terminal worker request', () => {
    const result = v.safeParse(CreateTerminalWorkerRequestSchema, {
      type: 'terminal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.type).toBe('terminal');
    }
  });

  it('should validate with optional name', () => {
    const result = v.safeParse(CreateTerminalWorkerRequestSchema, {
      type: 'terminal',
      name: 'My Terminal',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe('My Terminal');
    }
  });

  it('should reject wrong type', () => {
    const result = v.safeParse(CreateTerminalWorkerRequestSchema, {
      type: 'agent',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing type', () => {
    const result = v.safeParse(CreateTerminalWorkerRequestSchema, {
      name: 'My Terminal',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateWorkerRequestSchema', () => {
  it('should accept agent worker', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
      agentId: 'agent-123',
    });
    expect(result.success).toBe(true);
  });

  it('should accept terminal worker', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'terminal',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid type', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject agent worker without agentId', () => {
    const result = v.safeParse(CreateWorkerRequestSchema, {
      type: 'agent',
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
});
