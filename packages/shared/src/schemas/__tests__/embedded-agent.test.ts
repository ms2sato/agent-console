import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  EmbeddedAgentDefinitionSchema,
  CreateEmbeddedAgentRequestSchema,
  UpdateEmbeddedAgentRequestSchema,
  EmbeddedAgentCommandSchema,
  EmbeddedAgentEventSchema,
  EmbeddedAgentServerEventSchema,
  EmbeddedAgentStreamEventSchema,
} from '../embedded-agent.js';

const validDefinition = {
  id: 'def-1',
  name: 'Ollama qwen3:32b',
  description: 'Local model',
  provider: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:32b',
    apiKeyRef: 'my-key',
  },
  systemPrompt: 'You are helpful.',
  maxToolIterations: 25,
  createdBy: 'user-uuid',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('EmbeddedAgentDefinitionSchema', () => {
  it('accepts a valid full definition', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, validDefinition);
    expect(result.success).toBe(true);
  });

  it('accepts a minimal definition without optional fields', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      id: 'def-2',
      name: 'Minimal',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      createdBy: 'user-uuid',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL baseUrl', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      provider: { ...validDefinition.provider, baseUrl: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key nested in provider (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      provider: { ...validDefinition.provider, unexpectedField: 'leaked' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxToolIterations of 0', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      maxToolIterations: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer maxToolIterations', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      maxToolIterations: 2.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateEmbeddedAgentRequestSchema', () => {
  it('accepts a valid create request', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
    });
    expect(result.success).toBe(true);
  });

  it('trims the name and rejects empty names', () => {
    const trimmed = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: '  Trimmed  ',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
    });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.output.name).toBe('Trimmed');
    }

    const empty = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: '   ',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
    });
    expect(empty.success).toBe(false);
  });

  it('rejects a createdBy field in the body (server-side only)', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      createdBy: 'attacker-uuid',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateEmbeddedAgentRequestSchema', () => {
  it('accepts an empty patch (no change)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {});
    expect(result.success).toBe(true);
  });

  it('accepts null-clears for nullable fields', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      description: null,
      systemPrompt: null,
      maxToolIterations: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.description).toBeNull();
      expect(result.output.systemPrompt).toBeNull();
      expect(result.output.maxToolIterations).toBeNull();
    }
  });

  it('accepts a whole-object provider replacement', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      provider: { baseUrl: 'http://localhost:8080/v1', model: 'vllm-model' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a null provider (provider is not clearable)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      provider: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('EmbeddedAgentCommandSchema', () => {
  it('parses each command variant', () => {
    const init = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      maxToolIterations: 25,
    };
    expect(v.safeParse(EmbeddedAgentCommandSchema, init).success).toBe(true);
    expect(
      v.safeParse(EmbeddedAgentCommandSchema, { v: 1, type: 'user-message', id: 'm1', text: 'hi' }).success
    ).toBe(true);
    expect(v.safeParse(EmbeddedAgentCommandSchema, { v: 1, type: 'cancel' }).success).toBe(true);
    expect(v.safeParse(EmbeddedAgentCommandSchema, { v: 1, type: 'shutdown' }).success).toBe(true);
  });

  it('rejects a version other than 1', () => {
    const result = v.safeParse(EmbeddedAgentCommandSchema, { v: 2, type: 'cancel' });
    expect(result.success).toBe(false);
  });
});

describe('EmbeddedAgentEventSchema', () => {
  it('parses each loop-authored event variant', () => {
    const events = [
      { v: 1, type: 'ready' },
      { v: 1, type: 'state', state: 'active' },
      { v: 1, type: 'state', state: 'idle' },
      { v: 1, type: 'assistant-delta', turnId: 't1', text: 'partial' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'full' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: { a: 1 } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
      { v: 1, type: 'turn-error', turnId: 't1', message: 'boom' },
      { v: 1, type: 'fatal', message: 'dead' },
    ];
    for (const event of events) {
      expect(v.safeParse(EmbeddedAgentEventSchema, event).success).toBe(true);
    }
  });

  it('rejects an invalid state value', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, { v: 1, type: 'state', state: 'asking' });
    expect(result.success).toBe(false);
  });

  it('rejects a server-authored exited event (narrow union)', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, { v: 1, type: 'exited', code: 0 });
    expect(result.success).toBe(false);
  });
});

describe('EmbeddedAgentServerEventSchema', () => {
  it('parses the user-message and exited events', () => {
    expect(
      v.safeParse(EmbeddedAgentServerEventSchema, { v: 1, type: 'user-message', id: 'm1', text: 'hi' }).success
    ).toBe(true);
    expect(v.safeParse(EmbeddedAgentServerEventSchema, { v: 1, type: 'exited', code: 0 }).success).toBe(true);
  });

  it('parses an exited event with null code', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, { v: 1, type: 'exited', code: null });
    expect(result.success).toBe(true);
  });
});

describe('EmbeddedAgentStreamEventSchema', () => {
  it('parses both loop events and server events', () => {
    expect(v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'ready' }).success).toBe(true);
    expect(
      v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'assistant-message', turnId: 't1', text: 'full' }).success
    ).toBe(true);
    expect(
      v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'user-message', id: 'm1', text: 'hi' }).success
    ).toBe(true);
    expect(v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'exited', code: null }).success).toBe(true);
  });

  it('rejects an unknown event type', () => {
    const result = v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'nope' });
    expect(result.success).toBe(false);
  });
});
