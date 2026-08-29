import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { EmbeddedAgentCommandSchema, type EmbeddedAgentEvent } from '@agent-console/shared';
import {
  runLoop,
  type LoopFactories,
  type LoopIO,
  type McpClientLike,
} from '../main.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRunRequest,
  type ToolDefinition,
} from '../providers/types.js';
import type { ToolCallOutcome } from '../mcp.js';
import type { Engine } from '../engine-types.js';
import type { SdkEngineDeps } from '../sdk-engine.js';
import { loadOptInInstructions } from '../system-prompt.js';

const mainPath = join(import.meta.dir, '..', 'main.ts');

// Temp-dir helper for tests that need a real filesystem `cwd` (mirrors
// system-prompt.test.ts's makeTempDir -- kept local rather than shared, since
// the two test files aren't otherwise coupled).
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embedded-agent-main-claude-md-'));
  tempDirs.push(dir);
  return dir;
}

const initCommand = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    type: 'init',
    compaction: { auto: false },
    engine: 'openai-api',
    mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
    provider: { baseUrl: 'http://provider/v1', model: 'm' },
    context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
    maxToolIterations: 5,
    ...overrides,
  });

class StubAdapter implements ProviderAdapter {
  async *run(_req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    yield { type: 'text-delta', text: 'hi' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

/** Captures every ProviderRunRequest.tools it was invoked with, for asserting
 * what CompositeToolExecutor merged into the tools list at the process
 * boundary (distinct from the narrower resolveEnabledBuiltinTools unit test
 * in tools/__tests__/index.test.ts). */
class CapturingAdapter implements ProviderAdapter {
  readonly capturedToolsCalls: ProviderRunRequest['tools'][] = [];
  readonly capturedMessagesCalls: ProviderRunRequest['messages'][] = [];
  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    this.capturedToolsCalls.push(req.tools);
    this.capturedMessagesCalls.push(req.messages);
    yield { type: 'text-delta', text: 'hi' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

/** Default `createSdkEngine` stub for tests that don't exercise the
 * claude-sdk init arm -- a no-op Engine that satisfies the interface without
 * driving any real (or fake) SDK query stream. */
class NoopEngine implements Engine {
  async runTurn(): Promise<void> {}
  cancel(): void {}
  setAutoCompaction(): void {}
  async handoff(): Promise<void> {}
}

class StubMcpClient implements McpClientLike {
  constructor(private readonly onConnect?: () => Promise<void>) {}
  async connect(): Promise<void> {
    if (this.onConnect) await this.onConnect();
  }
  async listTools(): Promise<ToolDefinition[]> {
    return [];
  }
  async callTool(): Promise<ToolCallOutcome> {
    return { ok: true, result: 'ok' };
  }
}

interface Captured {
  io: LoopIO;
  events: EmbeddedAgentEvent[];
  errors: string[];
}

function makeIo(lines: string[]): Captured {
  const events: EmbeddedAgentEvent[] = [];
  const errors: string[] = [];
  const io: LoopIO = {
    async *readCommands() {
      for (const line of lines) yield line;
    },
    writeEvent: (event) => events.push(event),
    logError: (message) => errors.push(message),
  };
  return { io, events, errors };
}

function makeFactories(overrides: Partial<LoopFactories> = {}): LoopFactories {
  return {
    createMcpClient: () => new StubMcpClient(),
    createAdapter: () => new StubAdapter(),
    loadInstructions: async () => ({ segments: [] }),
    loadOptInInstructions: async () => [],
    loadCompactionPrompt: async () => ({ content: 'DEFAULT_COMPACTION_PROMPT_STUB', origin: 'bundled-default' }),
    createSdkEngine: () => new NoopEngine(),
    // R1: default the pre-flight to "the session exists" so the vast
    // majority of tests, which are not about resume at all, exercise the
    // resume-is-honoured path. The resume tests override it explicitly.
    probeSdkSession: async () => 'found',
    ...overrides,
  };
}

describe('runLoop — protocol enforcement', () => {
  it('exits 2 when the first message is not an init', async () => {
    const { io } = makeIo([JSON.stringify({ v: 1, type: 'user-message', id: 'x', text: 'hi' })]);
    expect(await runLoop(io, makeFactories())).toBe(2);
  });

  it('exits 2 on malformed JSON', async () => {
    const { io } = makeIo(['not json']);
    expect(await runLoop(io, makeFactories())).toBe(2);
  });

  it('exits 2 when the first init fails schema validation', async () => {
    const { io } = makeIo([JSON.stringify({ v: 1, type: 'init' })]);
    expect(await runLoop(io, makeFactories())).toBe(2);
  });

  it('exits 2 when a known command after init fails schema validation', async () => {
    const { io, events } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message' }), // missing id/text
    ]);
    expect(await runLoop(io, makeFactories())).toBe(2);
    expect(events.some((e) => e.type === 'ready')).toBe(true);
  });

  it('ignores an unknown command type after init and continues', async () => {
    const { io, errors } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'future-thing' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    expect(await runLoop(io, makeFactories())).toBe(0);
    expect(errors.some((e) => e.includes('unknown type'))).toBe(true);
  });
});

describe('runLoop — lifecycle', () => {
  it('emits ready after init and exits 0 on shutdown', async () => {
    const { io, events } = makeIo([initCommand(), JSON.stringify({ v: 1, type: 'shutdown' })]);
    expect(await runLoop(io, makeFactories())).toBe(0);
    expect(events[0]).toEqual({ v: 1, type: 'ready' });
  });

  it('exits 0 on stdin EOF (no shutdown command)', async () => {
    const { io } = makeIo([initCommand()]);
    expect(await runLoop(io, makeFactories())).toBe(0);
  });

  it('runs a turn for a user-message and emits an assistant-message', async () => {
    const { io, events } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    expect(await runLoop(io, makeFactories())).toBe(0);
    const assistant = events.find((e) => e.type === 'assistant-message');
    expect(assistant).toMatchObject({ turnId: 'u1', text: 'hi' });
  });

  it('emits a fatal event and exits 1 when MCP connection fails', async () => {
    const { io, events } = makeIo([initCommand()]);
    const factories = makeFactories({
      createMcpClient: () =>
        new StubMcpClient(async () => {
          throw new Error('connection refused');
        }),
    });
    expect(await runLoop(io, factories)).toBe(1);
    expect(events.some((e) => e.type === 'fatal')).toBe(true);
  });

  it('waits out the drain timeout (~2.5s, not the pre-bump 2s) before exiting on shutdown when the in-flight turn never settles', async () => {
    // Simulates a turn stuck on a provider/tool call that ignores cancel()'s
    // AbortSignal (e.g. a Bash child that ignored SIGTERM) — the scenario the
    // TURN_DRAIN_TIMEOUT_MS bump (2000ms -> 2500ms) exists to give more
    // headroom for on the shutdown path.
    class HangingAdapter implements ProviderAdapter {
      async *run(): AsyncIterable<ProviderEvent> {
        await new Promise<never>(() => {}); // never resolves; ignores req.signal entirely
        yield { type: 'done', finishReason: 'stop' }; // unreachable
      }
    }
    const { io } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({ createAdapter: () => new HangingAdapter() });

    const start = performance.now();
    const exitCode = await runLoop(io, factories);
    const elapsed = performance.now() - start;

    expect(exitCode).toBe(0);
    // Comfortably above the pre-bump 2000ms value and below a generous upper
    // bound -- proves gracefulExit actually drained for ~2500ms rather than
    // the old constant.
    expect(elapsed).toBeGreaterThanOrEqual(2400);
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('runLoop — builtin tool merging (enabledTools)', () => {
  it('merges the default builtin tools (Read/Glob/Grep) with MCP tools when enabledTools is absent', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({ createAdapter: () => adapter });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedToolsCalls).toHaveLength(1);
    const toolNames = adapter.capturedToolsCalls[0].map((t) => t.name).sort();
    // `Compact` sits alongside the builtins but is not one of them: the loop
    // prepends it itself, outside the registry `enabledTools` configures.
    expect(toolNames).toEqual(['Compact', 'Glob', 'Grep', 'Read']);
  });

  it('drops an MCP tool that collides with the reserved Compact name, and says so', async () => {
    // The loop intercepts `Compact` by name before dispatch, so an MCP tool
    // published under it would be permanently unreachable with no diagnostic,
    // and the provider would receive two definitions sharing one name.
    const adapter = new CapturingAdapter();
    const { io, errors } = makeIo([
      initCommand({ enabledTools: [] }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    class McpPublishingCompact extends StubMcpClient {
      async listTools() {
        return [
          { name: 'Compact', description: 'an unrelated MCP tool', parameters: {} },
          { name: 'close_session', description: 'closes', parameters: {} },
        ];
      }
    }
    const factories = makeFactories({
      createAdapter: () => adapter,
      createMcpClient: () => new McpPublishingCompact(),
    });

    expect(await runLoop(io, factories)).toBe(0);
    const published = adapter.capturedToolsCalls[0];
    // Exactly one `Compact` reaches the provider, and it is the loop's own.
    expect(published.filter((t) => t.name === 'Compact')).toHaveLength(1);
    expect(published.find((t) => t.name === 'Compact')?.description).not.toBe(
      'an unrelated MCP tool',
    );
    // Unrelated MCP tools are untouched.
    expect(published.map((t) => t.name)).toContain('close_session');
    // The shadowing is reported rather than silent.
    expect(errors.join('\n')).toContain('collides with the loop\'s reserved compaction tool');
  });

  it('passes ONLY the MCP tools (zero builtins) when enabledTools is an explicit empty array', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand({ enabledTools: [] }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    class McpWithOneTool extends StubMcpClient {
      async listTools() {
        return [{ name: 'close_session', description: 'closes', parameters: {} }];
      }
    }
    const factories = makeFactories({
      createAdapter: () => adapter,
      createMcpClient: () => new McpWithOneTool(),
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedToolsCalls).toHaveLength(1);
    // `enabledTools: []` is the strongest form of "every builtin off" -- and
    // `Compact` is still published, because no representable value of
    // `enabledTools` can reach it (see compact-tool.ts's self-management
    // tool class). Only the MCP tool and Compact are present; zero builtins.
    expect(adapter.capturedToolsCalls[0].map((t) => t.name)).toEqual(['Compact', 'close_session']);
    expect(adapter.capturedToolsCalls[0]).toContainEqual({
      name: 'close_session',
      description: 'closes',
      parameters: {},
    });
  });
});

describe('runLoop — instructions threading into the system prompt (Wave 5-4)', () => {
  it('threads loadInstructions segments into the system prompt reaching the provider request payload', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand({ instructions: ['docs/local-note.md'] }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({
      createAdapter: () => adapter,
      loadInstructions: async (params) => {
        expect(params.instructionsList).toEqual(['docs/local-note.md']);
        return {
          segments: [{ origin: '/tmp/instructions/docs/local-note.md', content: 'INSTRUCTION_MARKER' }],
        };
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedMessagesCalls).toHaveLength(1);
    const systemMessage = adapter.capturedMessagesCalls[0].find((m) => m.role === 'system');
    expect(systemMessage?.content).toContain(
      '--- Instructions: /tmp/instructions/docs/local-note.md ---',
    );
    expect(systemMessage?.content).toContain('INSTRUCTION_MARKER');
  });
});

describe('runLoop — restoredConversation threading (Transcript Restore #1123)', () => {
  it('threads init.restoredConversation into the constructed AgentLoop, seeding the first provider request from it (system-prompt content is R2-overridden -- see the dedicated R2 test below)', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand({
        restoredConversation: [
          { role: 'system', content: 'RESTORED_SYSTEM_PROMPT' },
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'follow-up' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({ createAdapter: () => adapter });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedMessagesCalls).toHaveLength(1);
    // NOTE: CapturingAdapter stores `req.messages` by reference (not a
    // snapshot), and that reference is AgentLoop's own `this.conversation`
    // array -- so by the time this assertion runs (after the turn has fully
    // completed), the array also carries the assistant reply appended after
    // the request was sent.
    //
    // R2 (architect audit, #1123): the loop now OVERRIDES the restored
    // conversation's system-prompt content with its own freshly-assembled
    // one (see `main.ts:initializeLoop`), so 'RESTORED_SYSTEM_PROMPT' does
    // NOT survive verbatim here -- this test's scope is threading the
    // REMAINING (non-system) restored messages plus the follow-up turn; the
    // system-prompt override itself is covered by the R2 test below.
    const [systemMessage, ...restMessages] = adapter.capturedMessagesCalls[0];
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.content).not.toBe('RESTORED_SYSTEM_PROMPT');
    expect(restMessages).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('seeds a fresh system-prompt-only conversation when restoredConversation is absent (default v1 behavior, unchanged)', async () => {
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hello' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({ createAdapter: () => adapter });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedMessagesCalls).toHaveLength(1);
    const [systemMessage, secondMessage] = adapter.capturedMessagesCalls[0];
    expect(systemMessage.role).toBe('system');
    expect(secondMessage).toEqual({ role: 'user', content: 'hello' });
  });

  it('overrides the restored conversation\'s system-prompt content with the loop\'s own correctly-permissioned reassembly (R2, multi-user Q9 blind spot)', async () => {
    // The server-side reconstruction (EmbeddedAgentWorkerService.runActivation)
    // reads instructions AS THE SERVER PROCESS'S OWN OS USER, which can
    // silently degrade in multi-user mode (worktree not readable by that
    // user). The loop runs as the REQUESTING user and computes its own
    // systemPrompt via loadInstructions/assembleSystemPrompt -- that value
    // must win over whatever the server placed at restoredConversation[0].
    const adapter = new CapturingAdapter();
    const { io } = makeIo([
      initCommand({
        restoredConversation: [
          { role: 'system', content: 'STALE_SERVER_PROMPT' },
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'follow-up' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({
      createAdapter: () => adapter,
      loadInstructions: async () => ({
        segments: [{ origin: '/tmp/instructions/AGENTS.md', content: 'LOOP_SIDE_INSTRUCTION_MARKER' }],
      }),
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(adapter.capturedMessagesCalls).toHaveLength(1);
    const [systemMessage, secondMessage] = adapter.capturedMessagesCalls[0];
    expect(systemMessage.role).toBe('system');
    expect(systemMessage.content).not.toContain('STALE_SERVER_PROMPT');
    expect(systemMessage.content).toContain('LOOP_SIDE_INSTRUCTION_MARKER');
    expect(secondMessage).toEqual({ role: 'user', content: 'earlier question' });
  });
});

/**
 * Issue #1419: `init.restoredUsage` reaching the restore-boundary decision.
 *
 * The observable is deliberately the DECISION, not the plumbing: asserting
 * that the field was read would pass against a loop that read it and then
 * ignored it, which is the whole failure mode. The two cases below differ in
 * exactly one input -- the seed -- and produce opposite activation
 * behaviours, with the seed's own value visible in the published reading.
 *
 * MEASURED REACH (mutation, run -- not predicted):
 *
 *   m11  drop the `...(init.engine === 'openai-api' && ...)` spread in
 *        `main.ts` so the seed never reaches the AgentLoop
 *        -> 2 fail: 'compacts at activation on the seed' and 'publishes the
 *           seeded reading'. The absent-seed case correctly survives, since
 *           dropping the field is exactly what that case already asserts.
 */
describe('runLoop — restoredUsage threading (#1419)', () => {
  // 2400 chars of restored user text ~= 600 estimated tokens; the assembled
  // system prompt adds well under 250 more. Either way the estimate stays
  // below T x W = 850, so the seed is the ONLY thing that can fire a
  // compaction here.
  const restoredConversation = [
    { role: 'system', content: 'RESTORED_SYSTEM_PROMPT' },
    { role: 'user', content: 'U'.repeat(2400) },
  ];
  const compaction = { auto: true, contextWindowTokens: 1000 };

  it('compacts at activation on the seed, where the estimate alone would not', async () => {
    const { io, events } = makeIo([
      initCommand({
        compaction,
        restoredConversation,
        restoredUsage: { promptTokens: 900, estimated: false },
      }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories())).toBe(0);

    const compactedAt = events.findIndex((e) => e.type === 'context-compacted');
    const readyAt = events.findIndex((e) => e.type === 'ready');
    expect(compactedAt).toBeGreaterThanOrEqual(0);
    // Ordering is part of the contract: the compaction is awaited inside
    // `init`, so it lands before `ready` rather than racing the first turn.
    expect(compactedAt).toBeLessThan(readyAt);
  });

  it('publishes the seeded reading as the restored worker’s pre-turn usage', async () => {
    const { io, events } = makeIo([
      initCommand({
        compaction,
        restoredConversation,
        restoredUsage: { promptTokens: 900, estimated: false },
      }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories())).toBe(0);

    // The seed's own value and honesty flag, not merely "a reading appeared":
    // a loop that fell back to the estimator would publish a smaller number
    // with `estimated: true`.
    expect(events.find((e) => e.type === 'context-usage')).toEqual({
      v: 1,
      type: 'context-usage',
      promptTokens: 900,
      estimated: false,
    });
  });

  it('falls back to the estimator when the init carries no seed', async () => {
    const { io, events } = makeIo([
      initCommand({ compaction, restoredConversation }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories())).toBe(0);

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    const usage = events.find((e) => e.type === 'context-usage');
    if (usage?.type !== 'context-usage') throw new Error('expected a context-usage event');
    expect(usage.estimated).toBe(true);
    expect(usage.promptTokens).toBeLessThan(850);
  });
});

describe('runLoop — engine discriminant containment (SDK Engine Phase 1)', () => {
  // `initializeLoop` narrows `init.engine` at runtime
  // (`if (init.engine === 'openai-api') { ... } else { new SdkEngine(...) }`)
  // and TypeScript enforces the SAME split at compile time via
  // `EmbeddedAgentCommand`'s discriminated union: an `openai-api`-shaped
  // `init.provider` (baseUrl/model/apiKey?) is structurally incompatible
  // with the `claude-sdk` arm's `provider: { model: string }`, so code that
  // narrows to one arm cannot read the other arm's fields. This test proves
  // the WIRE-LEVEL half of that containment: the shared schema rejects an
  // openai-api-shaped init command carrying `engine: 'claude-sdk'` (an
  // apiKey field the claude-sdk arm's strictObject provider must never
  // accept -- see docs/design/embedded-agent-sdk-engine.md §3.2 and §7's
  // "Auth property test").
  it('rejects a claude-sdk init command whose provider carries an apiKey (openai-api-shaped payload misdeclared as claude-sdk)', () => {
    const command = {
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5', apiKey: 'sk-leaked' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, command);
    expect(result.success).toBe(false);
  });

  it('accepts a claude-sdk init command whose provider carries only `model` (no apiKey field to leak)', () => {
    const command = {
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
    };
    const result = v.safeParse(EmbeddedAgentCommandSchema, command);
    expect(result.success).toBe(true);
    if (result.success && result.output.type === 'init' && result.output.engine === 'claude-sdk') {
      expect('apiKey' in result.output.provider).toBe(false);
    }
  });

  // Mirrors the openai-api branch's "emits a fatal event and exits 1 when
  // MCP connection fails" test above: `SdkEngine`'s constructor calls the
  // real SDK's `query()` synchronously, so a throw there must be caught and
  // surfaced the same way the native branch's MCP-connect failure is,
  // instead of propagating uncaught out of `initializeLoop`/`runLoop`.
  it('emits a fatal event and exits 1 when SdkEngine construction throws synchronously', async () => {
    const claudeSdkInitCommand = JSON.stringify({
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
    });
    const { io, events, errors } = makeIo([claudeSdkInitCommand]);
    const factories = makeFactories({
      createSdkEngine: () => {
        throw new Error('malformed options rejected by the SDK');
      },
    });

    expect(await runLoop(io, factories)).toBe(1);
    const fatalEvents = events.filter(
      (e): e is Extract<EmbeddedAgentEvent, { type: 'fatal' }> => e.type === 'fatal',
    );
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('malformed options rejected by the SDK');
    expect(errors.some((e) => e.includes('malformed options rejected by the SDK'))).toBe(true);
  });
});

describe('runLoop — the retired handoff command (#1401)', () => {
  const claudeSdkInitCommand = () =>
    JSON.stringify({
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
    });

  it('ignores a `handoff` command as an unknown type, without exiting', async () => {
    // `handoff` left `EmbeddedAgentCommand` with the compaction swap.
    // Commands are not persisted, so nothing replays one -- but a server
    // running an older build could still write one, and the forward-compat
    // unknown-type branch is what must catch it: logged and skipped, never a
    // protocol exit that would kill an otherwise healthy worker.
    const { io, errors } = makeIo([
      claudeSdkInitCommand(),
      JSON.stringify({ v: 1, type: 'handoff' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories())).toBe(0);
    expect(errors.some((e) => e.includes('unknown type: handoff'))).toBe(true);
  });
});

describe('runLoop — claude-sdk engine: opt-in instructions threading', () => {
  const claudeSdkInitCommand = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
      ...overrides,
    });

  it('loads the definition instructions[] list via loadOptInInstructions and composes it into systemPromptAppend, ordered before the definition system prompt', async () => {
    const { io } = makeIo([
      claudeSdkInitCommand({ instructions: ['docs/local-note.md'], systemPrompt: 'OPERATOR_PROMPT' }),
    ]);
    let capturedDeps: SdkEngineDeps | undefined;
    const factories = makeFactories({
      loadOptInInstructions: async (cwd, instructionsList) => {
        expect(cwd).toBe('/tmp');
        expect(instructionsList).toEqual(['docs/local-note.md']);
        return [{ origin: '/tmp/docs/local-note.md', content: 'INSTRUCTION_MARKER' }];
      },
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(capturedDeps?.systemPromptAppend).toContain('INSTRUCTION_MARKER');
    expect(capturedDeps?.systemPromptAppend).toContain('OPERATOR_PROMPT');
    const instructionIdx = capturedDeps!.systemPromptAppend!.indexOf('INSTRUCTION_MARKER');
    const operatorIdx = capturedDeps!.systemPromptAppend!.indexOf('OPERATOR_PROMPT');
    expect(operatorIdx).toBeGreaterThan(instructionIdx);
  });

  it('omits systemPromptAppend entirely when neither instructions[] nor a definition system prompt are configured (no regression)', async () => {
    const { io } = makeIo([claudeSdkInitCommand()]);
    let capturedDeps: SdkEngineDeps | undefined;
    const factories = makeFactories({
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(capturedDeps?.systemPromptAppend).toBeUndefined();
  });

  it('systemPromptAppend contains only the definition system prompt when instructions[] is unconfigured (no regression)', async () => {
    const { io } = makeIo([claudeSdkInitCommand({ systemPrompt: 'OPERATOR_ONLY' })]);
    let capturedDeps: SdkEngineDeps | undefined;
    const factories = makeFactories({
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(capturedDeps?.systemPromptAppend).toBe('OPERATOR_ONLY');
  });

});

// Phase 1's builtin claude-sdk definition (claude-sdk-builtin.ts) bakes
// `instructions: ['CLAUDE.md']` -- this is the ONLY way CLAUDE.md content
// reaches this engine's context (settingSources: [] disables the SDK's own
// native auto-discovery; see docs/design/embedded-agent-sdk-engine.md §4.2).
// Unlike the block above (which stubs `loadOptInInstructions` to prove the
// composition/ordering contract), this block wires in the REAL production
// `loadOptInInstructions` against a real temp-dir CLAUDE.md file, proving the
// builtin's configured value actually resolves end-to-end into
// `systemPromptAppend` -- not just that the composition function honors
// whatever segments it's handed.
describe('runLoop — claude-sdk engine: CLAUDE.md opt-in delivery (builtin definition\'s instructions: ["CLAUDE.md"])', () => {
  const claudeSdkInitCommand = (cwd: string, overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd },
      maxToolIterations: 5,
      instructions: ['CLAUDE.md'],
      ...overrides,
    });

  it('reads a real CLAUDE.md file at cwd via the real loadOptInInstructions and composes its content into systemPromptAppend', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'CLAUDE.md'), 'PROJECT_CLAUDE_MD_MARKER');
    const { io } = makeIo([claudeSdkInitCommand(dir)]);
    let capturedDeps: SdkEngineDeps | undefined;
    const factories = makeFactories({
      loadOptInInstructions, // real production implementation, not a stub
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(capturedDeps?.systemPromptAppend).toContain('PROJECT_CLAUDE_MD_MARKER');
  });

  it('polarity: with instructions: [] (no CLAUDE.md opt-in), systemPromptAppend omits the CLAUDE.md content even though the same file exists on disk', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'CLAUDE.md'), 'PROJECT_CLAUDE_MD_MARKER');
    const { io } = makeIo([claudeSdkInitCommand(dir, { instructions: [] })]);
    let capturedDeps: SdkEngineDeps | undefined;
    const factories = makeFactories({
      loadOptInInstructions, // real production implementation, not a stub
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    expect(capturedDeps?.systemPromptAppend).toBeUndefined();
  });
});

describe('main subprocess — init-first enforcement', () => {
  it('exits 2 when a user-message arrives before init', async () => {
    const proc = Bun.spawn(['bun', mainPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write(`${JSON.stringify({ v: 1, type: 'user-message', id: 'x', text: 'hi' })}\n`);
    await proc.stdin.end();
    expect(await proc.exited).toBe(2);
  });

  it('exits 2 when the first stdin line is malformed JSON', async () => {
    const proc = Bun.spawn(['bun', mainPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.write('this is not json\n');
    await proc.stdin.end();
    expect(await proc.exited).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Transcript Restore, R1 (#1410): the resume pre-flight
// ---------------------------------------------------------------------------

describe('runLoop — claude-sdk resume pre-flight (R1)', () => {
  function sdkInit(resume?: { sdkSessionId: string }): string {
    return JSON.stringify({
      v: 1,
      type: 'init',
      compaction: { auto: false },
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp/work' },
      maxToolIterations: 5,
      ...(resume !== undefined ? { resume } : {}),
    });
  }

  it('accepts `resume` on the claude-sdk arm and rejects it on openai-api', () => {
    // Structural containment, not convention: the field lives on the
    // claude-sdk arm precisely so an openai-api init carrying one is not
    // representable. `resume` on the wrong arm must fail the shared schema.
    const shared = {
      v: 1,
      type: 'init',
      compaction: { auto: false },
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
      resume: { sdkSessionId: 'sess-1' },
    };
    expect(
      v.safeParse(EmbeddedAgentCommandSchema, {
        ...shared,
        engine: 'claude-sdk',
        provider: { model: 'claude-sonnet-5' },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(EmbeddedAgentCommandSchema, {
        ...shared,
        engine: 'openai-api',
        provider: { baseUrl: 'http://p/v1', model: 'm' },
      }).success,
    ).toBe(false);
  });

  it('forwards the resume id to the engine when the pre-flight finds the session', async () => {
    let capturedDeps: SdkEngineDeps | undefined;
    const preflightCalls: { id: string; cwd: string }[] = [];
    const { io, events } = makeIo([sdkInit({ sdkSessionId: 'sess-live' })]);
    await runLoop(
      io,
      makeFactories({
        probeSdkSession: async (id, cwd) => {
          preflightCalls.push({ id, cwd });
          return 'found';
        },
        createSdkEngine: (deps) => {
          capturedDeps = deps;
          return new NoopEngine();
        },
      }),
    );

    expect(capturedDeps?.resume).toBe('sess-live');
    // The `dir` hint is the worker's own cwd -- it scopes the lookup to this
    // project instead of searching every one on the host.
    expect(preflightCalls).toEqual([{ id: 'sess-live', cwd: '/tmp/work' }]);
    expect(events.filter((e) => e.type === 'sdk-resume-failed')).toHaveLength(0);
  });

  it('starts fresh and reports `not-found` when the pre-flight cannot find the session', async () => {
    // The common failure, moved off the user's first message: the resume is
    // never attempted, so no turn is lost and no incarnation needs replacing.
    let capturedDeps: SdkEngineDeps | undefined;
    const { io, events } = makeIo([sdkInit({ sdkSessionId: 'sess-gone' })]);
    await runLoop(
      io,
      makeFactories({
        probeSdkSession: async () => 'not-found',
        createSdkEngine: (deps) => {
          capturedDeps = deps;
          return new NoopEngine();
        },
      }),
    );

    expect(capturedDeps?.resume).toBeUndefined();
    const failures = events.filter((e) => e.type === 'sdk-resume-failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ requestedSdkSessionId: 'sess-gone', reason: 'not-found' });
  });

  it('starts fresh and reports `lookup-failed` when the pre-flight could not run', async () => {
    // The distinction this whole change exists to carry. `not-found` and
    // `error` do the SAME thing here -- both start fresh -- so a mapping
    // that flattened them would look completely correct at this layer and
    // still cost the server the one bit it needs to decide whether the
    // persisted id is worth keeping.
    let capturedDeps: SdkEngineDeps | undefined;
    const { io, events } = makeIo([sdkInit({ sdkSessionId: 'sess-unreadable' })]);
    await runLoop(
      io,
      makeFactories({
        probeSdkSession: async () => 'error',
        createSdkEngine: (deps) => {
          capturedDeps = deps;
          return new NoopEngine();
        },
      }),
    );

    // Same fresh start as `not-found` -- an unreadable store is no more
    // resumable, right now, than a missing session.
    expect(capturedDeps?.resume).toBeUndefined();
    const failures = events.filter((e) => e.type === 'sdk-resume-failed');
    expect(failures).toHaveLength(1);
    // Polarity measured by mutation: changing the `'error'` arm to emit
    // `reason: 'not-found'` fails ONLY this assertion in this file, and
    // nothing else in the package. The `toHaveLength(1)` and the
    // `resume === undefined` above both pass under the flattened mapping,
    // which is exactly why they are not the pin.
    expect(failures[0]).toMatchObject({ requestedSdkSessionId: 'sess-unreadable', reason: 'lookup-failed' });
  });

  it('does not pre-flight at all when the init carries no resume', async () => {
    // A first-ever activation must not consult the session store: there is
    // nothing to look up, and a lookup here would be the engine inventing a
    // resume id, which the re-scoped pin forbids.
    let capturedDeps: SdkEngineDeps | undefined;
    let preflightCalls = 0;
    const { io, events } = makeIo([sdkInit()]);
    await runLoop(
      io,
      makeFactories({
        probeSdkSession: async () => {
          preflightCalls++;
          return 'found';
        },
        createSdkEngine: (deps) => {
          capturedDeps = deps;
          return new NoopEngine();
        },
      }),
    );

    expect(preflightCalls).toBe(0);
    expect(capturedDeps?.resume).toBeUndefined();
    expect(events.filter((e) => e.type === 'sdk-resume-failed')).toHaveLength(0);
  });
});

/**
 * Compaction at the restore boundary (#1411) — driven through `runLoop`, the
 * shipping path, rather than against `AgentLoop` directly. What only this
 * layer can establish: the event ORDER relative to `ready` (the server hangs
 * both initial-prompt delivery and the restore-info completion flip off
 * `ready`), and that a first user turn which WOULD have gone over the window
 * no longer does.
 *
 * See docs/design/embedded-agent-worker.md "Compaction at the restore
 * boundary".
 */

/** Rejects any request whose chars/4 estimate exceeds the window, the way an
 * OpenAI-compatible provider rejects an over-window prompt: a non-retryable
 * 400. Records every request it was given, accepted or rejected. */
class WindowedAdapter implements ProviderAdapter {
  readonly requestedTokens: number[] = [];
  constructor(
    private readonly windowTokens: number,
    private readonly replyText = 'ok',
  ) {}
  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    const estimate = Math.round(req.messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
    this.requestedTokens.push(estimate);
    if (estimate > this.windowTokens) {
      throw new ProviderError(
        `400 This model's maximum context length is ${this.windowTokens} tokens`,
        { retryable: false, status: 400 },
      );
    }
    yield { type: 'text-delta', text: this.replyText };
    yield { type: 'done', finishReason: 'stop' };
  }
}

/** A stream that keeps producing data and never ends, and never idles out.
 * This is the shape the activation budget exists for: the adapter's own
 * per-attempt timeout does not fire (data keeps arriving), so without a bound
 * `ready` waits on the adapter's total timeout times the retry count.
 *
 * SCOPE, stated honestly: this adapter COOPERATES with the abort signal, so
 * the test below proves the bound works against a cooperating adapter and
 * says nothing about one that ignores the signal. That is not a gap in the
 * test but a division of labour -- an iterator that never settles cannot be
 * stopped by any consumer, so the obligation lives in the `ProviderAdapter`
 * contract (see its `run` doc comment) and is measured against the shipping
 * adapter in openai-chat-adapter.test.ts, not here. */
class NeverEndingAdapter implements ProviderAdapter {
  runs = 0;
  async *run(req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    this.runs++;
    for (;;) {
      if (req.signal.aborted) return;
      yield { type: 'text-delta', text: '.' };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Every provider call fails immediately and non-retryably — the shape of a
 * provider that is simply not there at activation time. Non-retryable
 * deliberately: `AgentLoop`'s backoff sleeps are not injectable through
 * `runLoop`, and a retryable error would buy 2.5s of real waiting for a
 * distinction this test is not about. */
class DeadAdapter implements ProviderAdapter {
  // eslint-disable-next-line require-yield
  async *run(_req: ProviderRunRequest): AsyncIterable<ProviderEvent> {
    throw new ProviderError('connection refused', { retryable: false });
  }
}

describe('runLoop — compaction at the restore boundary (#1411)', () => {
  const WINDOW = 1000;

  /** Restored conversation of roughly `chars` characters past the system
   * message, which `main.ts` replaces with its own ~433-char assembly. */
  const restoredOf = (...contents: string[]) => [
    { role: 'system', content: 'SERVER_SIDE_PLACEHOLDER' },
    ...contents.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content })),
  ];

  it('emits the context-compacted marker BEFORE ready, and ready exactly once', async () => {
    // ~433-char system prompt + 3000 chars => ~858 estimated tokens, inside
    // the [850, 900] full-compaction band for a 1000-token window.
    const { io, events } = makeIo([
      initCommand({
        compaction: { auto: true, contextWindowTokens: WINDOW },
        restoredConversation: restoredOf('U'.repeat(3000)),
      }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories())).toBe(0);

    const markerIndex = events.findIndex((e) => e.type === 'context-compacted');
    const readyIndex = events.findIndex((e) => e.type === 'ready');
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeLessThan(readyIndex);
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
  });

  it('still reports ready when the boundary compaction FAILS — a dead provider at activation must not wedge the worker', async () => {
    // "Not before ready" means not before the compaction FINISHES, never
    // before it SUCCEEDS. The conversation is preserved, a turn-error is
    // surfaced, and the worker goes on to accept commands.
    const { io, events } = makeIo([
      initCommand({
        compaction: { auto: true, contextWindowTokens: WINDOW },
        restoredConversation: restoredOf('U'.repeat(3000)),
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'still working?' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories({ createAdapter: () => new DeadAdapter() }))).toBe(0);

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn-error')).toBeDefined();
    const readyEvents = events.filter((e) => e.type === 'ready');
    expect(readyEvents).toHaveLength(1);
    // ...and the worker really was usable afterwards: the user-message was
    // accepted and driven to a turn of its own (it fails against the dead
    // provider, which is the point -- the failure is the PROVIDER's, not a
    // wedged activation).
    expect(events.filter((e) => e.type === 'turn-error').length).toBeGreaterThanOrEqual(2);
  });

  it('BOUNDS the boundary compaction: a provider stream that emits forever does not hold ready hostage', async () => {
    // Without the budget this test would hang for the adapter's total timeout
    // times the retry count -- and `cancel`/`shutdown` sit behind the same
    // await as `ready`, so the worker would be unstoppable meanwhile. The
    // budget aborts the in-flight distillation through `AgentLoop.cancel()`,
    // which lands in `compact()`'s existing canceled branch.
    const adapter = new NeverEndingAdapter();
    const { io, events } = makeIo([
      initCommand({
        compaction: { auto: true, contextWindowTokens: WINDOW },
        restoredConversation: restoredOf('U'.repeat(3000)),
      }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    const started = Date.now();
    expect(
      await runLoop(
        io,
        makeFactories({ createAdapter: () => adapter, restoreBoundaryCompactionBudgetMs: 40 }),
      ),
    ).toBe(0);

    // The compaction was attempted, abandoned, and reported as a failure...
    expect(adapter.runs).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError && 'message' in turnError ? turnError.message : '').toBe(
      'Context compaction failed: turn canceled',
    );
    // ...and activation completed anyway, well inside the unbounded exposure.
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('E2E: a restored conversation past the window is partially distilled, and the first user turn does not go over the window', async () => {
    // ~433 system + 4000 + 4000 + 400 = ~8833 chars => ~2208 tokens against a
    // 1000-token window: far past the 0.9 full-distill ceiling, so the
    // distillation input itself must be narrowed to the 700-token budget.
    const adapter = new WindowedAdapter(WINDOW, 'DISTILLED');
    const { io, events } = makeIo([
      initCommand({
        compaction: { auto: true, contextWindowTokens: WINDOW },
        restoredConversation: restoredOf('A'.repeat(4000), 'B'.repeat(4000), 'C'.repeat(400)),
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'follow-up' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories({ createAdapter: () => adapter }))).toBe(0);

    const marker = events.find((e) => e.type === 'context-compacted');
    expect(marker).toMatchObject({ source: 'auto' });
    expect(marker && 'summary' in marker ? marker.summary : '').toBe(
      '[Earlier messages exceeded the context window and are not covered by this summary.] DISTILLED',
    );
    // Nothing the provider was asked to answer exceeded the window, so
    // nothing 400'd -- neither the distillation nor the user turn.
    expect(adapter.requestedTokens.every((t) => t <= WINDOW)).toBe(true);
    expect(events.find((e) => e.type === 'turn-error')).toBeUndefined();
    expect(events.find((e) => e.type === 'assistant-message')).toMatchObject({ text: 'DISTILLED' });
  });

  it('POLARITY: with the boundary compaction disabled, the very first provider call goes over the window and 400s', async () => {
    // The control for the E2E above -- identical restored conversation and
    // identical window, with only the worker's auto toggle turned off, which
    // is exactly what disables the boundary compaction. If this passes AND
    // the E2E above passes, the compaction is what made the difference.
    const adapter = new WindowedAdapter(WINDOW, 'DISTILLED');
    const { io, events } = makeIo([
      initCommand({
        compaction: { auto: false, contextWindowTokens: WINDOW },
        restoredConversation: restoredOf('A'.repeat(4000), 'B'.repeat(4000), 'C'.repeat(400)),
      }),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'follow-up' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);

    expect(await runLoop(io, makeFactories({ createAdapter: () => adapter }))).toBe(0);

    expect(events.find((e) => e.type === 'context-compacted')).toBeUndefined();
    expect(adapter.requestedTokens).toHaveLength(1);
    expect(adapter.requestedTokens[0]).toBeGreaterThan(WINDOW);
    const turnError = events.find((e) => e.type === 'turn-error');
    expect(turnError && 'message' in turnError ? turnError.message : '').toContain(
      'maximum context length',
    );
  });
});
