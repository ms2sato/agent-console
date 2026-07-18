import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  EmbeddedAgentDefinitionSchema,
  CreateEmbeddedAgentRequestSchema,
  UpdateEmbeddedAgentRequestSchema,
  EmbeddedAgentHandoffConfigSchema,
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

  it('accepts a valid enabledTools array', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      enabledTools: ['Read', 'Glob'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an enabledTools array with a duplicate tool name', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      enabledTools: ['Read', 'Read'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit empty enabledTools array (all builtin tools off)', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      enabledTools: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a definition with enabledTools absent (default applies downstream)', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, validDefinition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.enabledTools).toBeUndefined();
    }
  });

  it('rejects an unknown tool name in enabledTools', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      enabledTools: ['NotARealTool'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid instructions array', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      instructions: ['docs/local-note.md', 'CONTRIBUTING.md'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit empty instructions array', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      instructions: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a definition with instructions absent', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, validDefinition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.instructions).toBeUndefined();
    }
  });

  it('rejects an empty-string entry in instructions', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      instructions: [''],
    });
    expect(result.success).toBe(false);
  });

  it('accepts duplicate paths in instructions (no dedup check, unlike enabledTools)', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      instructions: ['docs/note.md', 'docs/note.md'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a positive integer contextWindowTokens', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      contextWindowTokens: 128000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a definition with contextWindowTokens absent', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, validDefinition);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.contextWindowTokens).toBeUndefined();
    }
  });

  it('rejects a non-integer contextWindowTokens', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      contextWindowTokens: 128000.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a contextWindowTokens of 0', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      contextWindowTokens: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative contextWindowTokens', () => {
    const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
      ...validDefinition,
      contextWindowTokens: -1,
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

  it('accepts a valid enabledTools array', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      enabledTools: ['Read', 'Glob', 'Grep'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an enabledTools array with a duplicate tool name', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      enabledTools: ['Read', 'Read'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid instructions array', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      instructions: ['docs/local-note.md'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a positive integer contextWindowTokens', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      contextWindowTokens: 32000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a create request with contextWindowTokens absent', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.contextWindowTokens).toBeUndefined();
    }
  });

  it('rejects a non-integer contextWindowTokens', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      contextWindowTokens: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive contextWindowTokens', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      contextWindowTokens: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid handoff config', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      handoff: { softRatio: 0.7, hardRatio: 0.9, auto: true },
    });
    expect(result.success).toBe(true);
  });
});

describe('EmbeddedAgentHandoffConfigSchema', () => {
  it('accepts a fully-populated config', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, {
      softRatio: 0.7,
      hardRatio: 0.9,
      auto: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (all fields optional)', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, {});
    expect(result.success).toBe(true);
  });

  it('accepts a config with only softRatio set', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 0.5 });
    expect(result.success).toBe(true);
  });

  it('accepts a config with only hardRatio set', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { hardRatio: 0.85 });
    expect(result.success).toBe(true);
  });

  it('accepts a config with only auto set', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { auto: false });
    expect(result.success).toBe(true);
  });

  it('accepts boundary ratio values 0 and 1', () => {
    const zero = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 0, hardRatio: 0 });
    expect(zero.success).toBe(true);
    const one = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 1, hardRatio: 1 });
    expect(one.success).toBe(true);
  });

  it('rejects an inverted pair where softRatio > hardRatio', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 0.9, hardRatio: 0.5 });
    expect(result.success).toBe(false);
  });

  it('accepts softRatio === hardRatio (boundary, not inverted)', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 0.75, hardRatio: 0.75 });
    expect(result.success).toBe(true);
  });

  it('rejects a softRatio below 0', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects a softRatio above 1', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 1.1 });
    expect(result.success).toBe(false);
  });

  it('rejects a hardRatio below 0', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { hardRatio: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects a hardRatio above 1', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { hardRatio: 1.1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean auto', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { auto: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentHandoffConfigSchema, { softRatio: 0.5, unexpectedField: 'leaked' });
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

  it('accepts enabledTools: null (clear to default)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      enabledTools: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.enabledTools).toBeNull();
    }
  });

  it('accepts a valid enabledTools replacement array', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      enabledTools: ['Grep'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an enabledTools replacement array with a duplicate tool name', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      enabledTools: ['Grep', 'Grep'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts instructions: null (clear)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      instructions: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.instructions).toBeNull();
    }
  });

  it('accepts a valid instructions replacement array', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      instructions: ['CONTRIBUTING.md'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts contextWindowTokens: null (clear to default)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      contextWindowTokens: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.contextWindowTokens).toBeNull();
    }
  });

  it('accepts contextWindowTokens absent (no change)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.contextWindowTokens).toBeUndefined();
    }
  });

  it('accepts a valid contextWindowTokens replacement', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      contextWindowTokens: 64000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive contextWindowTokens replacement', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      contextWindowTokens: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts handoff: null (clear to default)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      handoff: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.handoff).toBeNull();
    }
  });

  it('accepts handoff absent (no change)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.handoff).toBeUndefined();
    }
  });

  it('accepts a whole-object handoff replacement with only some sub-fields set', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      handoff: { softRatio: 0.6 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.handoff).toEqual({ softRatio: 0.6 });
    }
  });

  it('rejects a handoff replacement with an out-of-range sub-field', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      handoff: { hardRatio: 1.5 },
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
    expect(v.safeParse(EmbeddedAgentCommandSchema, { v: 1, type: 'handoff' }).success).toBe(true);
    expect(v.safeParse(EmbeddedAgentCommandSchema, { v: 1, type: 'shutdown' }).success).toBe(true);
  });

  it('rejects a handoff command with an unknown field (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentCommandSchema, { v: 1, type: 'handoff', reason: 'manual' });
    expect(result.success).toBe(false);
  });

  it('rejects a handoff command missing v', () => {
    const result = v.safeParse(EmbeddedAgentCommandSchema, { type: 'handoff' });
    expect(result.success).toBe(false);
  });

  it('rejects a version other than 1', () => {
    const result = v.safeParse(EmbeddedAgentCommandSchema, { v: 2, type: 'cancel' });
    expect(result.success).toBe(false);
  });

  it('parses an init command carrying enabledTools', () => {
    const init = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      enabledTools: ['Read'],
      maxToolIterations: 25,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, init);
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'init') {
      expect(result.output.enabledTools).toEqual(['Read']);
    }
  });

  it('rejects an init command with a duplicate tool name in enabledTools', () => {
    const init = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      enabledTools: ['Read', 'Read'],
      maxToolIterations: 25,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, init);
    expect(result.success).toBe(false);
  });

  it('parses an init command carrying instructions', () => {
    const init = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      instructions: ['docs/local-note.md'],
      maxToolIterations: 25,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, init);
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'init') {
      expect(result.output.instructions).toEqual(['docs/local-note.md']);
    }
  });

  it('rejects an init command with an empty-string entry in instructions', () => {
    const init = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      instructions: [''],
      maxToolIterations: 25,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, init);
    expect(result.success).toBe(false);
  });

  it('parses an init command without instructions (absent, not required)', () => {
    const init = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      maxToolIterations: 25,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, init);
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'init') {
      expect(result.output.instructions).toBeUndefined();
    }
  });

  describe('restoredConversation (Transcript Restore #1123)', () => {
    const baseInit = {
      v: 1,
      type: 'init',
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      maxToolIterations: 25,
    };

    it('parses an init command without restoredConversation (absent, not required)', () => {
      const result = v.safeParse(EmbeddedAgentCommandSchema, baseInit);
      expect(result.success).toBe(true);
      if (result.success && result.output.type === 'init') {
        expect(result.output.restoredConversation).toBeUndefined();
      }
    });

    it('parses a restoredConversation covering all four message roles', () => {
      const init = {
        ...baseInit,
        restoredConversation: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'run', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'result' },
        ],
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(true);
      if (result.success && result.output.type === 'init') {
        expect(result.output.restoredConversation).toHaveLength(4);
      }
    });

    it('parses an assistant message without tool_calls (optional)', () => {
      const init = {
        ...baseInit,
        restoredConversation: [{ role: 'assistant', content: 'hello' }],
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(true);
    });

    it('rejects a restoredConversation entry with an unknown role', () => {
      const init = {
        ...baseInit,
        restoredConversation: [{ role: 'developer', content: 'x' }],
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('rejects a tool message missing tool_call_id', () => {
      const init = {
        ...baseInit,
        restoredConversation: [{ role: 'tool', content: 'result' }],
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('rejects a tool_calls entry with an unknown field (strictObject)', () => {
      const init = {
        ...baseInit,
        restoredConversation: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'run', arguments: '{}' }, extra: 'leak' },
            ],
          },
        ],
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('accepts an empty restoredConversation array', () => {
      const init = { ...baseInit, restoredConversation: [] };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(true);
    });
  });
});

describe('EmbeddedAgentEventSchema', () => {
  it('parses each loop-authored event variant', () => {
    const events = [
      { v: 1, type: 'ready' },
      { v: 1, type: 'state', state: 'active' },
      { v: 1, type: 'state', state: 'idle' },
      { v: 1, type: 'assistant-delta', turnId: 't1', text: 'partial' },
      { v: 1, type: 'assistant-thinking-delta', turnId: 't1', text: 'thinking...' },
      { v: 1, type: 'assistant-message', turnId: 't1', text: 'full' },
      { v: 1, type: 'tool-call', turnId: 't1', callId: 'c1', name: 'run', args: { a: 1 } },
      { v: 1, type: 'tool-result', turnId: 't1', callId: 'c1', ok: true, result: 'done' },
      { v: 1, type: 'turn-error', turnId: 't1', message: 'boom' },
      { v: 1, type: 'fatal', message: 'dead' },
      { v: 1, type: 'context-usage', promptTokens: 1234, estimated: false },
      { v: 1, type: 'context-handoff', distillation: 'summary text' },
    ];
    for (const event of events) {
      expect(v.safeParse(EmbeddedAgentEventSchema, event).success).toBe(true);
    }
  });

  it('accepts a standalone context-usage event', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-usage',
      promptTokens: 1234,
      estimated: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a context-usage event missing estimated', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-usage',
      promptTokens: 1234,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a context-usage event with an unknown field (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-usage',
      promptTokens: 1234,
      estimated: false,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a context-usage event with a negative promptTokens', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-usage',
      promptTokens: -1,
      estimated: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a context-usage event with a fractional promptTokens', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-usage',
      promptTokens: 12.5,
      estimated: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a standalone context-handoff event', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-handoff',
      distillation: 'summary text',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a context-handoff event missing distillation', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-handoff',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a context-handoff event with an unknown field (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'context-handoff',
      distillation: 'summary text',
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a standalone assistant-thinking-delta event', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'assistant-thinking-delta',
      turnId: 't1',
      text: 'reasoning...',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an assistant-thinking-delta event missing text', () => {
    const result = v.safeParse(EmbeddedAgentEventSchema, {
      v: 1,
      type: 'assistant-thinking-delta',
      turnId: 't1',
    });
    expect(result.success).toBe(false);
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

  it('parses a user-message event with the optional clientMessageId field', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: 'hi',
      clientMessageId: 'client-generated-uuid',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({
        v: 1,
        type: 'user-message',
        id: 'm1',
        text: 'hi',
        clientMessageId: 'client-generated-uuid',
      });
    }
  });

  it('parses a user-message event WITHOUT clientMessageId (replay of files persisted before this field existed)', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, { v: 1, type: 'user-message', id: 'm1', text: 'hi' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('clientMessageId' in result.output).toBe(false);
    }
  });

  it('rejects a non-string clientMessageId', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: 'hi',
      clientMessageId: 42,
    });
    expect(result.success).toBe(false);
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

  it('parses context-usage and context-handoff events', () => {
    expect(
      v.safeParse(EmbeddedAgentStreamEventSchema, {
        v: 1,
        type: 'context-usage',
        promptTokens: 1234,
        estimated: true,
      }).success
    ).toBe(true);
    expect(
      v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'context-handoff', distillation: 'summary text' })
        .success
    ).toBe(true);
  });

  it('rejects an unknown event type', () => {
    const result = v.safeParse(EmbeddedAgentStreamEventSchema, { v: 1, type: 'nope' });
    expect(result.success).toBe(false);
  });
});
