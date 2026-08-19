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
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRunRequest,
  ToolDefinition,
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
    loadHandoffPrompt: async () => ({ content: 'DEFAULT_HANDOFF_PROMPT_STUB', origin: 'bundled-default' }),
    createSdkEngine: () => new NoopEngine(),
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
    expect(toolNames).toEqual(['Glob', 'Grep', 'Read']);
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
    expect(adapter.capturedToolsCalls[0]).toEqual([
      { name: 'close_session', description: 'closes', parameters: {} },
    ]);
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

describe('runLoop — claude-sdk engine: handoff dispatch gate (S3, #1334)', () => {
  const claudeSdkInitCommand = () =>
    JSON.stringify({
      v: 1,
      type: 'init',
      engine: 'claude-sdk',
      mcp: { baseUrl: 'http://mcp/local', token: 'tok' },
      provider: { model: 'claude-sonnet-5' },
      context: { sessionId: 's', workerId: 'w', cwd: '/tmp' },
      maxToolIterations: 5,
    });

  // A `handoff` command received while a turn is active is rejected at
  // main.ts's dispatch layer (the same `turnActive` gate `user-message` is
  // subject to) BEFORE it ever reaches `Engine.handoff()` -- this is
  // engine-agnostic dispatch-loop behavior, so the openai-api and
  // claude-sdk engines observe an IDENTICAL contract here by construction,
  // with no engine-specific code needed on either side. This is the
  // verification for docs/design/embedded-agent-sdk-engine.md's S3 AC line
  // "Handoff during an active turn: match the native engine's observable
  // contract."
  it('ignores a handoff command received while a turn is active, and never calls Engine.handoff()', async () => {
    let handoffCalled = false;
    let resolveTurn: (() => void) | null = null;
    class HangingEngine implements Engine {
      async runTurn(): Promise<void> {
        return new Promise<void>((resolve) => {
          resolveTurn = resolve;
        });
      }
      cancel(): void {
        resolveTurn?.();
      }
      async handoff(): Promise<void> {
        handoffCalled = true;
      }
    }

    const { io, errors } = makeIo([
      claudeSdkInitCommand(),
      JSON.stringify({ v: 1, type: 'user-message', id: 'u1', text: 'hi' }),
      JSON.stringify({ v: 1, type: 'handoff' }),
      JSON.stringify({ v: 1, type: 'shutdown' }),
    ]);
    const factories = makeFactories({ createSdkEngine: () => new HangingEngine() });

    expect(await runLoop(io, factories)).toBe(0);
    expect(handoffCalled).toBe(false);
    expect(errors.some((e) => e.includes('Ignoring handoff received while a turn is active'))).toBe(true);
  });
});

describe('runLoop — claude-sdk engine: opt-in instructions threading', () => {
  const claudeSdkInitCommand = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      type: 'init',
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

  it('wires loadHandoffPrompt to factories.loadHandoffPrompt (S3): the SAME single-writer prompt source the openai-api engine uses', async () => {
    const { io } = makeIo([claudeSdkInitCommand()]);
    let capturedDeps: SdkEngineDeps | undefined;
    const factories = makeFactories({
      loadHandoffPrompt: async ({ cwd }) => {
        expect(cwd).toBe('/tmp');
        return { content: 'FACTORY_HANDOFF_PROMPT', origin: 'bundled-default' };
      },
      createSdkEngine: (deps) => {
        capturedDeps = deps;
        return new NoopEngine();
      },
    });

    expect(await runLoop(io, factories)).toBe(0);
    await expect(capturedDeps!.loadHandoffPrompt()).resolves.toBe('FACTORY_HANDOFF_PROMPT');
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
