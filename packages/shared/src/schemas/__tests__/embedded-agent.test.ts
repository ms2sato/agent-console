import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  EmbeddedAgentDefinitionSchema,
  CreateEmbeddedAgentRequestSchema,
  UpdateEmbeddedAgentRequestSchema,
  EmbeddedAgentCompactionConfigSchema,
  EmbeddedAgentCommandSchema,
  EmbeddedAgentEventSchema,
  EmbeddedAgentServerEventSchema,
  EmbeddedAgentStreamEventSchema,
} from '../embedded-agent.js';

const validDefinition = {
  id: 'def-1',
  name: 'Ollama qwen3:32b',
  description: 'Local model',
  engine: 'openai-api',
  provider: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:32b',
    apiKeyRef: 'my-key',
  },
  systemPrompt: 'You are helpful.',
  maxToolIterations: 25,
  isBuiltIn: false,
  createdBy: 'user-uuid',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const validSdkDefinition = {
  id: 'def-sdk-1',
  name: 'Claude',
  engine: 'claude-sdk',
  provider: {
    model: 'claude-sonnet-5',
  },
  isBuiltIn: true,
  createdBy: 'system',
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
      engine: 'openai-api',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      isBuiltIn: false,
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

  describe('engine discriminant (SDK Engine Phase 1, docs/design/embedded-agent-sdk-engine.md §3.1)', () => {
    it('accepts a valid claude-sdk definition (no baseUrl/apiKeyRef on provider)', () => {
      const result = v.safeParse(EmbeddedAgentDefinitionSchema, validSdkDefinition);
      expect(result.success).toBe(true);
    });

    it('rejects an openai-api definition whose provider carries the claude-sdk shape (missing baseUrl)', () => {
      const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
        ...validDefinition,
        provider: { model: 'qwen3:32b' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a claude-sdk definition whose provider carries the openai-api shape (extra baseUrl)', () => {
      const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
        ...validSdkDefinition,
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'claude-sonnet-5' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a definition with an unknown engine literal', () => {
      const result = v.safeParse(EmbeddedAgentDefinitionSchema, {
        ...validDefinition,
        engine: 'raw-messages-api',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a definition missing the engine discriminant', () => {
      const { engine: _engine, ...withoutEngine } = validDefinition;
      const result = v.safeParse(EmbeddedAgentDefinitionSchema, withoutEngine);
      expect(result.success).toBe(false);
    });

    it('requires isBuiltIn on both arms', () => {
      const { isBuiltIn: _isBuiltIn, ...withoutIsBuiltIn } = validDefinition;
      const result = v.safeParse(EmbeddedAgentDefinitionSchema, withoutIsBuiltIn);
      expect(result.success).toBe(false);
    });
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

  it('accepts a valid compaction config', () => {
    const result = v.safeParse(CreateEmbeddedAgentRequestSchema, {
      name: 'New Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      compaction: { threshold: 0.7 },
    });
    expect(result.success).toBe(true);
  });
});

describe('EmbeddedAgentCompactionConfigSchema', () => {
  it('accepts a populated config', () => {
    const result = v.safeParse(EmbeddedAgentCompactionConfigSchema, { threshold: 0.85 });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (threshold falls to the default downstream)', () => {
    const result = v.safeParse(EmbeddedAgentCompactionConfigSchema, {});
    expect(result.success).toBe(true);
  });

  it('accepts 1 (compact only when the window is completely full)', () => {
    expect(v.safeParse(EmbeddedAgentCompactionConfigSchema, { threshold: 1 }).success).toBe(true);
  });

  it('REJECTS 0, which would compact after every turn including the first', () => {
    // 0 is inside [0, 1] but means nothing an operator would intend by
    // "compact when the context fills up" -- excluded deliberately rather
    // than accepted as a degenerate case.
    expect(v.safeParse(EmbeddedAgentCompactionConfigSchema, { threshold: 0 }).success).toBe(false);
  });

  it('rejects a threshold below 0', () => {
    expect(v.safeParse(EmbeddedAgentCompactionConfigSchema, { threshold: -0.1 }).success).toBe(false);
  });

  it('rejects a threshold above 1', () => {
    expect(v.safeParse(EmbeddedAgentCompactionConfigSchema, { threshold: 1.1 }).success).toBe(false);
  });

  it('rejects a non-numeric threshold', () => {
    expect(v.safeParse(EmbeddedAgentCompactionConfigSchema, { threshold: '0.85' }).success).toBe(false);
  });

  it('rejects an unknown key (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentCompactionConfigSchema, {
      threshold: 0.5,
      unexpectedField: 'leaked',
    });
    expect(result.success).toBe(false);
  });

  it('rejects the retired handoff sub-fields, so a stale caller fails loudly', () => {
    // A client still sending the old shape must not be silently accepted with
    // its threshold ignored -- that is the shape of a bug that looks like
    // working software.
    expect(
      v.safeParse(EmbeddedAgentCompactionConfigSchema, { softRatio: 0.75, hardRatio: 0.9 }).success,
    ).toBe(false);
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

  it('accepts compaction: null (clear to default)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      compaction: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.compaction).toBeNull();
    }
  });

  it('accepts compaction absent (no change)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.compaction).toBeUndefined();
    }
  });

  it('accepts a whole-object compaction replacement', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      compaction: { threshold: 0.6 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.compaction).toEqual({ threshold: 0.6 });
    }
  });

  it('rejects a compaction replacement with an out-of-range threshold', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      compaction: { threshold: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects the retired handoff key outright (strictObject)', () => {
    const result = v.safeParse(UpdateEmbeddedAgentRequestSchema, {
      handoff: { softRatio: 0.6 },
    });
    expect(result.success).toBe(false);
  });
});

describe('EmbeddedAgentCommandSchema', () => {
  it('parses each command variant', () => {
    const init = {
      v: 1,
      type: 'init',
      compaction: { auto: true },
      engine: 'openai-api',
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
      compaction: { auto: true },
      engine: 'openai-api',
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
      compaction: { auto: true },
      engine: 'openai-api',
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
      compaction: { auto: true },
      engine: 'openai-api',
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
      compaction: { auto: true },
      engine: 'openai-api',
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
      compaction: { auto: true },
      engine: 'openai-api',
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

  describe('engine discriminant (SDK Engine Phase 1, docs/design/embedded-agent-sdk-engine.md §3.1)', () => {
    const baseFields = {
      v: 1,
      type: 'init',
      compaction: { auto: true },
      mcp: { baseUrl: 'http://localhost:3457/mcp', token: 'tok' },
      context: { sessionId: 's1', workerId: 'w1', cwd: '/work' },
      maxToolIterations: 25,
    };

    it('parses a claude-sdk init command whose provider carries only model (no apiKey)', () => {
      const init = { ...baseFields, engine: 'claude-sdk', provider: { model: 'claude-sonnet-5' } };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(true);
      if (result.success && result.output.type === 'init' && result.output.engine === 'claude-sdk') {
        expect(result.output.provider).toEqual({ model: 'claude-sonnet-5' });
      }
    });

    it('rejects a claude-sdk init command whose provider carries baseUrl (openai-api shape)', () => {
      const init = {
        ...baseFields,
        engine: 'claude-sdk',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'claude-sonnet-5' },
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('rejects an openai-api init command whose provider is missing baseUrl (claude-sdk shape)', () => {
      const init = { ...baseFields, engine: 'openai-api', provider: { model: 'llama3' } };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('rejects an init command with an unknown engine literal', () => {
      const init = {
        ...baseFields,
        engine: 'raw-messages-api',
        provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('rejects an init command missing the engine discriminant', () => {
      const init = { ...baseFields, provider: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' } };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });

    it('rejects a claude-sdk init command whose provider carries an empty-string model', () => {
      const init = { ...baseFields, engine: 'claude-sdk', provider: { model: '' } };
      const result = v.safeParse(EmbeddedAgentCommandSchema, init);
      expect(result.success).toBe(false);
    });
  });

  describe('restoredConversation (Transcript Restore #1123)', () => {
    const baseInit = {
      v: 1,
      type: 'init',
      compaction: { auto: true },
      engine: 'openai-api',
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
      { v: 1, type: 'sdk-session-id', sdkSessionId: 'sdk-sess-1' },
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

  describe('sdk-session-id (SDK Engine Phase 1)', () => {
    it('accepts a standalone sdk-session-id event', () => {
      const result = v.safeParse(EmbeddedAgentEventSchema, {
        v: 1,
        type: 'sdk-session-id',
        sdkSessionId: 'sdk-sess-abc',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a sdk-session-id event missing sdkSessionId', () => {
      const result = v.safeParse(EmbeddedAgentEventSchema, { v: 1, type: 'sdk-session-id' });
      expect(result.success).toBe(false);
    });

    it('rejects a sdk-session-id event with an unknown field (strictObject)', () => {
      const result = v.safeParse(EmbeddedAgentEventSchema, {
        v: 1,
        type: 'sdk-session-id',
        sdkSessionId: 'sdk-sess-abc',
        unexpectedField: 'leaked',
      });
      expect(result.success).toBe(false);
    });
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

  it('parses a user-message event with a notification field carrying kind and summary (Issue #1351)', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: '\n[internal:message] source=session',
      notification: { kind: 'internal-message', summary: 'Message from session foo' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({
        v: 1,
        type: 'user-message',
        id: 'm1',
        text: '\n[internal:message] source=session',
        notification: { kind: 'internal-message', summary: 'Message from session foo' },
      });
    }
  });

  it('parses a user-message event WITHOUT notification (legacy replay -- old rows keep rendering as user bubbles)', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, { v: 1, type: 'user-message', id: 'm1', text: 'hi' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('notification' in result.output).toBe(false);
    }
  });

  it('parses a notification with kind only (no summary)', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: '\n[internal:timer] timerId=t1',
      notification: { kind: 'internal-timer' },
    });
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'user-message') {
      expect(result.output.notification).toEqual({ kind: 'internal-timer' });
      expect('summary' in (result.output.notification ?? {})).toBe(false);
    }
  });

  it('rejects an unknown notification kind', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: 'hi',
      notification: { kind: 'not-a-real-kind' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string notification summary', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: 'hi',
      notification: { kind: 'internal-message', summary: 42 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a notification with an unknown extra field (strictObject)', () => {
    const result = v.safeParse(EmbeddedAgentServerEventSchema, {
      v: 1,
      type: 'user-message',
      id: 'm1',
      text: 'hi',
      notification: { kind: 'internal-message', summary: 'hi', unexpectedField: 'leaked' },
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

  it('parses a user-message event with a notification field (Issue #1351)', () => {
    expect(
      v.safeParse(EmbeddedAgentStreamEventSchema, {
        v: 1,
        type: 'user-message',
        id: 'm1',
        text: 'hi',
        notification: { kind: 'internal-message', summary: 'Message from session foo' },
      }).success
    ).toBe(true);
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
