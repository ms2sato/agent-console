import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';

describe('shared index exports', () => {
  it('should re-export SCHEMA_VERSION as a 16-hex-char content hash', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.SCHEMA_VERSION).toBe('string');
    expect(mod.SCHEMA_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should re-export SchemaVersionMessageSchema that parses a valid schema-version frame', async () => {
    const mod = await import('../index.js');
    expect(mod.SchemaVersionMessageSchema).toBeDefined();
    const result = v.safeParse(mod.SchemaVersionMessageSchema, {
      type: 'schema-version',
      version: mod.SCHEMA_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it('should export InteractiveProcessInfo type', async () => {
    const mod = await import('../index.js');
    // InteractiveProcessInfo is a type-only export — verify the module loads successfully
    expect(mod).toBeDefined();
  });

  it('should export SkillDefinition type', async () => {
    const mod = await import('../index.js');
    // SkillDefinition is a type-only export — verify the module loads successfully
    expect(mod).toBeDefined();
  });

  it('should export MessageTemplate type', async () => {
    const mod = await import('../index.js');
    expect(mod).toBeDefined();
  });

  it('should export message contract utilities', async () => {
    const mod = await import('../index.js');

    // Verify message contract exports from Issue #660 prevention system
    expect(mod.MessageContentUtils).toBeDefined();
    expect(mod.SubmitKeystrokeUtils).toBeDefined();
    expect(mod.isMessageContent).toBeDefined();
    expect(mod.isSubmitKeystroke).toBeDefined();
    expect(typeof mod.MessageContentUtils.create).toBe('function');
    expect(typeof mod.SubmitKeystrokeUtils.create).toBe('function');
  });

  it('should export ApiError interface correctly', async () => {
    const mod = await import('../index.js');

    // ApiError is a TypeScript interface, verify module loads and structure
    expect(mod).toBeDefined();

    // Test ApiError interface usage pattern
    const apiError = {
      error: 'TEST_ERROR',
      message: 'Test error message'
    };

    expect(apiError.error).toBe('TEST_ERROR');
    expect(apiError.message).toBe('Test error message');
  });

  it('should re-export the embedded-agent valibot schemas', async () => {
    const mod = await import('../index.js');

    // Runtime schema exports surfaced through schemas/index.js barrel.
    expect(mod.EmbeddedAgentDefinitionSchema).toBeDefined();
    expect(mod.CreateEmbeddedAgentRequestSchema).toBeDefined();
    expect(mod.UpdateEmbeddedAgentRequestSchema).toBeDefined();
    expect(mod.EmbeddedAgentCommandSchema).toBeDefined();
    expect(mod.EmbeddedAgentEventSchema).toBeDefined();
    expect(mod.EmbeddedAgentServerEventSchema).toBeDefined();
    expect(mod.EmbeddedAgentStreamEventSchema).toBeDefined();

    // The re-exported schemas must actually parse — verify one boundary schema
    // rejects an empty create request and accepts a well-formed one.
    const rejected = v.safeParse(mod.CreateEmbeddedAgentRequestSchema, {});
    expect(rejected.success).toBe(false);

    const accepted = v.safeParse(mod.CreateEmbeddedAgentRequestSchema, {
      name: 'My Agent',
      provider: { baseUrl: 'https://api.example.com', model: 'gpt-4' },
    });
    expect(accepted.success).toBe(true);
  });

  it('should re-export NdjsonLineSplitter and split a chunk into lines', async () => {
    const mod = await import('../index.js');

    expect(mod.NdjsonLineSplitter).toBeDefined();
    const splitter = new mod.NdjsonLineSplitter();
    const result = splitter.push('{"a":1}\n{"b":2}');
    expect(result.lines).toEqual(['{"a":1}']);
    expect(splitter.carry).toBe('{"b":2}');
  });

  it('should re-export AGENT_KINDS and the AgentKind values it derives', async () => {
    const mod = await import('../index.js');

    // AGENT_KINDS is the single writer of the 'terminal' | 'embedded' union
    // (packages/shared/src/types/agent-surface.ts) — verify the runtime
    // constant is actually re-exported through the barrel, not just the
    // type-only AgentKind/AgentSurface/AgentDirectoryEntry/AgentResolution.
    expect(mod.AGENT_KINDS).toEqual(['terminal', 'embedded']);
  });

  it('should re-export AGENT_OPERATIONS as the single-writer cross-surface operation enum', async () => {
    const mod = await import('../index.js');

    // AGENT_OPERATIONS is the single writer consumed by the UI / MCP /
    // embedded-visible exposure tables (packages/shared/src/types/agent-operations.ts)
    // -- verify the runtime constant is actually re-exported through the
    // barrel, not just the type-only AgentOperation/SurfaceExposure.
    expect(mod.AGENT_OPERATIONS).toEqual([
      'listAgents',
      'resolveAgent',
      'createSessionWithAgent',
      'addWorkerToSession',
      'manageDefinitions',
      'restart',
    ]);
  });

  it('should export Artifact type and the ArtifactSchema runtime schema', async () => {
    const mod = await import('../index.js');

    // Artifact is a type-only export from Issue #1312 (HTML Artifacts phase
    // 1) -- verify the module loads successfully.
    expect(mod).toBeDefined();

    // ArtifactSchema is a real runtime value, re-exported transitively via
    // `export * from './schemas/index.js'` in the same barrel -- verify it
    // is actually present and parses a well-formed artifact.
    expect(mod.ArtifactSchema).toBeDefined();
    const accepted = v.safeParse(mod.ArtifactSchema, {
      id: 'artifact-id',
      title: 'My Artifact',
      createdAt: '2026-04-27T00:00:00.000Z',
      sizeBytes: 1024,
    });
    expect(accepted.success).toBe(true);
  });

  it('should export Bookmark type and the BookmarkSchema runtime schema', async () => {
    const mod = await import('../index.js');

    // Bookmark is a type-only export -- verify the module loads successfully.
    expect(mod).toBeDefined();

    // BookmarkSchema is a real runtime value, re-exported transitively via
    // `export * from './schemas/index.js'` in the same barrel -- verify it
    // is actually present and parses a well-formed bookmark.
    expect(mod.BookmarkSchema).toBeDefined();
    const accepted = v.safeParse(mod.BookmarkSchema, {
      id: 'bookmark-id',
      url: 'https://example.com',
      title: null,
      createdAt: '2026-04-27T00:00:00.000Z',
      origin: 'user',
    });
    expect(accepted.success).toBe(true);
  });

  it('should export NotificationItem type and the NotificationItemSchema/NotificationsResponseSchema runtime schemas', async () => {
    const mod = await import('../index.js');

    // NotificationItem is a type-only export (Notification Center Phase 1,
    // Issue #1353) -- verify the module loads successfully.
    expect(mod).toBeDefined();

    // NotificationItemSchema / NotificationsResponseSchema are real runtime
    // values, re-exported transitively via `export * from './schemas/index.js'`
    // in the same barrel -- verify they are actually present and parse a
    // well-formed payload.
    expect(mod.NotificationItemSchema).toBeDefined();
    expect(mod.NotificationsResponseSchema).toBeDefined();

    const item = {
      kind: 'artifact-created',
      id: 'artifact-1',
      occurredAt: '2026-08-18T00:00:00.000Z',
      title: 'My Dashboard',
      link: '/artifacts/artifact-1',
    };
    const accepted = v.safeParse(mod.NotificationsResponseSchema, {
      items: [item],
      lastSeenAt: null,
      unreadCount: 1,
    });
    expect(accepted.success).toBe(true);
  });

  it('should export ConditionalWakeupInfo type', async () => {
    const mod = await import('../index.js');

    // ConditionalWakeupInfo is a type-only export from Issue #700 — verify the module loads successfully
    expect(mod).toBeDefined();

    // Test ConditionalWakeupInfo interface usage pattern
    const wakeupInfo = {
      id: 'test-id',
      sessionId: 'test-session',
      workerId: 'test-worker',
      intervalSeconds: 30,
      conditionScript: 'echo test',
      onTrueMessage: 'Test message',
      createdAt: '2026-04-27T00:00:00.000Z',
      checkCount: 0,
      status: 'running' as const
    };

    expect(wakeupInfo.id).toBe('test-id');
    expect(wakeupInfo.status).toBe('running');
    expect(wakeupInfo.intervalSeconds).toBe(30);
  });

  it('should re-export getAgentParameterCapabilities and buildAgentParameterTemplateVars (Issue #1541)', async () => {
    const mod = await import('../index.js');

    // Runtime function exports from types/agent-parameter-capabilities.js
    // (barrel export added in the same PR) -- verify they are actually
    // reachable through the public package entry point, not just present in
    // the source file.
    expect(typeof mod.getAgentParameterCapabilities).toBe('function');
    expect(typeof mod.buildAgentParameterTemplateVars).toBe('function');

    const capabilities = mod.getAgentParameterCapabilities({
      id: 'a',
      name: 'A',
      isBuiltIn: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      commandTemplate: 'cli {{model:+--model}}{{prompt}}',
      capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
    });
    expect(capabilities).toEqual({ model: true, reasoningEffort: false });

    expect(mod.buildAgentParameterTemplateVars({ model: 'opus', reasoningEffort: 'high' })).toEqual({
      model: 'opus',
      effort: 'high',
    });
  });

  it('should re-export EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES and EFFORT_LEVELS (Issue #1554)', async () => {
    const mod = await import('../index.js');

    // Runtime constant exports from types/embedded-agent-parameter-capabilities.js
    // (barrel export added in the same PR) -- verify they are actually
    // reachable through the public package entry point, not just present in
    // the source file.
    expect(mod.EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES).toBeDefined();
    expect(mod.EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    // The capability table is the single writer consumed by createWorker's
    // creation-time validation -- verify its actual per-engine shape is
    // reachable, not just that the module loaded.
    expect(mod.EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['claude-sdk'].reasoningEffort).toEqual({
      capable: true,
      acceptedValues: mod.EFFORT_LEVELS,
      consumptionSite: 'query() Options.effort (sdk-engine.ts buildOptions)',
    });
    expect(mod.EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES['openai-api'].reasoningEffort.capable).toBe(
      true,
    );
  });

  it('should re-export EMBEDDED_AGENT_SLASH_COMMANDS (#1572)', async () => {
    const mod = await import('../index.js');

    // Runtime constant export from types/embedded-agent-slash-commands.js
    // (barrel export added in the same PR) -- verify it is actually
    // reachable through the public package entry point, not just present in
    // the source file.
    expect(mod.EMBEDDED_AGENT_SLASH_COMMANDS).toBeDefined();
    expect(mod.EMBEDDED_AGENT_SLASH_COMMANDS['openai-api']).toEqual([
      { name: '/compact', description: 'Compact this conversation now', handledBy: 'console' },
    ]);
    expect(mod.EMBEDDED_AGENT_SLASH_COMMANDS['claude-sdk'].map((c: { name: string }) => c.name)).toEqual([
      '/compact',
      '/cost',
      '/context',
    ]);
  });
});
