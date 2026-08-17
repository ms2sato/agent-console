/**
 * Tests for the claude-sdk engine (docs/design/embedded-agent-sdk-engine.md,
 * Appendix A). Every test drives `SdkEngine` through the `queryFn` DI seam
 * with a fake replaying a scripted `SDKMessage` sequence -- no real `claude`
 * process is spawned. The one exception is the `spawnClaudeCodeProcess`
 * override test, which spawns a real short-lived process to prove the
 * override actually delegates to `node:child_process.spawn`.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbeddedAgentEvent } from '@agent-console/shared';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkEngine, spawnClaudeCodeProcess, type SdkEngineDeps } from '../sdk-engine.js';
import { composeSdkSystemPromptAppend } from '../system-prompt.js';

// ---------------------------------------------------------------------------
// Fixture cast escape hatches
// ---------------------------------------------------------------------------

/**
 * The single, documented `as unknown as SDKMessage` escape hatch for this
 * file's fixture builders. The real `SDKMessage` union carries dozens of
 * required fields per variant that this engine never reads; fixtures
 * intentionally populate only the fields the engine's mapping logic actually
 * consumes. Every fixture builder below routes its return value through this
 * helper instead of casting inline, so the escape hatch exists in exactly one
 * place.
 */
function asSdkMessage(value: Record<string, unknown>): SDKMessage {
  return value as unknown as SDKMessage;
}

/**
 * The single, documented `as unknown as Query` escape hatch for
 * `makeFakeQuery`'s returned fake. The real `Query` interface is an
 * `AsyncGenerator` intersected with SDK-internal methods this fake does not
 * need to fully replicate; `makeFakeQuery` only implements the subset
 * (`interrupt`, `close`, iteration) that `SdkEngine` actually calls.
 */
function asQuery(value: object): Query {
  return value as unknown as Query;
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Narrow view of `typeof query` sufficient for these tests. */
type QueryFn = (params: { prompt: unknown; options?: Options }) => Query;

interface FakeQueryHandle {
  queryFn: QueryFn;
  captured: { options?: Options };
  isClosed: () => boolean;
  interruptCallCount: () => number;
}

/**
 * Builds a fake `queryFn` (the DI seam SdkEngine's constructor calls). The
 * returned `Query`-shaped object replays either a fixed array of canned
 * `SDKMessage`s or a caller-supplied generator, independent of what is
 * pushed onto the real prompt queue -- tests control turn-scoping by calling
 * `engine.runTurn(id, text)` synchronously right after construction (before
 * any `await`), which sets `currentTurnId` before the detached background
 * consumer has a chance to process any message.
 */
function makeFakeQuery(source: SDKMessage[] | (() => AsyncGenerator<SDKMessage, void>)): FakeQueryHandle {
  const captured: { options?: Options } = {};
  let closed = false;
  let interruptCalls = 0;

  const queryFn: QueryFn = (params) => {
    captured.options = params.options;
    const gen =
      typeof source === 'function'
        ? source()
        : (async function* (): AsyncGenerator<SDKMessage, void> {
            for (const m of source) yield m;
            // The real Query stays alive for the engine's whole lifetime
            // (see sdk-engine.ts's module doc comment) -- it never exhausts
            // on its own. Block forever after replaying the canned messages
            // so a finite fixture array doesn't spuriously trip the "clean
            // stream end" fatal path (see the "clean stream end" describe
            // block below) unless a test opts into that behavior via a
            // custom generator function passed as `source` instead.
            await new Promise<never>(() => {});
          })();
    const fake = Object.assign(gen, {
      interrupt: async () => {
        interruptCalls++;
        return undefined;
      },
      close: () => {
        closed = true;
      },
    });
    return asQuery(fake);
  };

  return {
    queryFn,
    captured,
    isClosed: () => closed,
    interruptCallCount: () => interruptCalls,
  };
}

/** A generator that never yields and never resolves -- models "system:init
 * never arrives" for the ready/system:init decoupling regression guard. */
function neverYieldingGenerator(): AsyncGenerator<SDKMessage, void> {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    await new Promise<never>(() => {});
  }
  return gen();
}

/** Drains the microtask queue (a single macrotask boundary drains ALL
 * currently- and newly-queued microtasks first), letting the detached
 * background consumer process a canned message sequence with no pending-turn
 * promise to await. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function eventsOfType<T extends EmbeddedAgentEvent['type']>(
  events: EmbeddedAgentEvent[],
  type: T,
): Extract<EmbeddedAgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<EmbeddedAgentEvent, { type: T }> => e.type === type);
}

const baseDeps = (overrides: Partial<SdkEngineDeps> = {}): SdkEngineDeps => ({
  cwd: '/tmp/work',
  model: 'claude-sonnet-5',
  mcp: { baseUrl: 'http://mcp.local', token: 'tok-123' },
  emit: () => {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// SDKMessage fixture builders -- minimally populated (only the fields this
// engine actually reads), routed through `asSdkMessage` (see "Fixture cast
// escape hatches" above) since the real SDK types carry dozens of unrelated
// required fields this codebase does not own.
// ---------------------------------------------------------------------------

function systemInit(overrides: { sessionId?: string; tools?: string[] } = {}): SDKMessage {
  return asSdkMessage({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: '2.1.233',
    cwd: '/tmp/work',
    tools: overrides.tools ?? ['Read', 'Glob', 'Grep'],
    mcp_servers: [{ name: 'agent-console', status: 'connected' }],
    model: 'claude-sonnet-5',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'text',
    skills: [],
    plugins: [],
    uuid: '11111111-1111-1111-1111-111111111111',
    session_id: overrides.sessionId ?? '22222222-2222-2222-2222-222222222222',
  });
}

function textDeltaEvent(text: string): SDKMessage {
  return asSdkMessage({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111112',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function thinkingDeltaEvent(thinking: string): SDKMessage {
  return asSdkMessage({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking, estimated_tokens: null },
    },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111113',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function inputJsonDeltaEvent(partialJson: string): SDKMessage {
  return asSdkMessage({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111114',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function messageStopEvent(): SDKMessage {
  return asSdkMessage({
    type: 'stream_event',
    event: { type: 'message_stop' },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111115',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function assistantToolUseMessage(callId: string, name: string, input: unknown): SDKMessage {
  return asSdkMessage({
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'tool_use', id: callId, name, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {},
      container: null,
      context_management: null,
      diagnostics: null,
      model: 'claude-sonnet-5',
      stop_details: null,
    },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111116',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function userToolResultMessage(toolUseId: string, content: string, isError = false): SDKMessage {
  return asSdkMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111117',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function userToolResultMessageWithBlockContent(toolUseId: string, content: unknown[]): SDKMessage {
  return asSdkMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111118',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function resultSuccess(): SDKMessage {
  return asSdkMessage({
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: '11111111-1111-1111-1111-111111111119',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

function resultError(
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries',
  errors: string[] = [],
): SDKMessage {
  return asSdkMessage({
    type: 'result',
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: '11111111-1111-1111-1111-111111111120',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

// ---------------------------------------------------------------------------
// Pin 1(a) -- construction seam / Options battery
// ---------------------------------------------------------------------------

describe('SdkEngine — construction seam: the query() Options battery (Pin 1(a))', () => {
  it('constructs the required security/isolation/DI shape', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));

    const options = captured.options!;
    expect(options.spawnClaudeCodeProcess).toBe(spawnClaudeCodeProcess);
    expect(options.executable).toBe('bun');
    expect(options.cwd).toBe('/tmp/work');
    expect(options.model).toBe('claude-sonnet-5');
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.includePartialMessages).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toEqual({ autoCompactEnabled: false });
    expect(options.mcpServers).toEqual({
      'agent-console': {
        type: 'http',
        url: 'http://mcp.local',
        headers: { Authorization: 'Bearer tok-123' },
        alwaysLoad: true,
      },
    });
    // No `resume` key at all -- not merely `undefined`.
    expect('resume' in options).toBe(false);
    // No apiKey-derived value anywhere in the constructed options: the
    // claude-sdk init arm's `provider` never carries one (enforced by the
    // shared discriminated schema -- see main.test.ts's containment test),
    // and this engine never reads or forwards such a field. Defensive
    // structural check on the actual constructed object, not just the type.
    expect(JSON.stringify(options)).not.toContain('apiKey');
  });

  it('appends the definition system prompt onto the SDK preset when configured', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, systemPromptAppend: 'Be terse.' }));
    expect(captured.options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Be terse.',
    });
  });

  it('omits systemPrompt entirely when no append is configured', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));
    expect('systemPrompt' in (captured.options ?? {})).toBe(false);
  });

  it('uses the definition enabledTools array for options.tools when provided', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: ['Read', 'Bash'] }));
    expect(captured.options?.tools).toEqual(['Read', 'Bash']);
  });

  it('defaults options.tools to the read-only default set when enabledTools is absent', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));
    expect(captured.options?.tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('passes an explicit empty array (not the preset object) when enabledTools is []', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: [] }));
    expect(captured.options?.tools).toEqual([]);
  });

  // Instruction loader forwarding (CodeRabbit finding, docs/design/embedded-
  // agent-sdk-engine.md §4's corrected "Instruction loader" row): the
  // definition's opt-in `instructions[]` is composed into `systemPromptAppend`
  // by main.ts's `initializeLoop` (via `composeSdkSystemPromptAppend`) BEFORE
  // `SdkEngine` is constructed -- this engine itself never reads instruction
  // files. These two tests exercise the real composition helper's output as
  // the deps value, proving the round trip: composed instruction content
  // actually reaches `options.systemPrompt.append`, ordered before the
  // definition system prompt, and the no-configuration case still omits
  // `systemPrompt` entirely (no regression from the "omits systemPrompt
  // entirely" test above).
  it('carries composed opt-in instruction content into options.systemPrompt.append, ordered before the definition system prompt', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    const segments = [{ origin: '/tmp/work/NOTES.md', content: 'INSTRUCTION_CONTENT' }];
    const systemPromptAppend = composeSdkSystemPromptAppend(segments, 'Be terse.');
    new SdkEngine(baseDeps({ queryFn, systemPromptAppend }));

    expect(captured.options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    });
    const append = (captured.options?.systemPrompt as { append: string }).append;
    const instructionIdx = append.indexOf('INSTRUCTION_CONTENT');
    const definitionIdx = append.indexOf('Be terse.');
    expect(instructionIdx).toBeGreaterThanOrEqual(0);
    expect(definitionIdx).toBeGreaterThan(instructionIdx);
  });

  it('omits systemPrompt.append when neither instructions nor a definition system prompt are configured (no regression)', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    const systemPromptAppend = composeSdkSystemPromptAppend([], undefined);
    expect(systemPromptAppend).toBeUndefined();

    new SdkEngine(baseDeps({ queryFn, systemPromptAppend }));
    expect('systemPrompt' in (captured.options ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pin 1(b) -- grep containment
// ---------------------------------------------------------------------------

describe('SdkEngine — construction seam containment (Pin 1(b))', () => {
  function collectProductionTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectProductionTsFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('invokes the SDK query() function from exactly one production call site', () => {
    const srcDir = join(import.meta.dir, '..');
    const files = collectProductionTsFiles(srcDir);
    const hits: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const matches = content.match(/this\.queryFn\(/g);
      if (matches) hits.push(...matches.map(() => file));
    }
    expect(hits).toEqual([join(srcDir, 'sdk-engine.ts')]);
  });

  it('defines exactly one spawnClaudeCodeProcess override function in production code', () => {
    const srcDir = join(import.meta.dir, '..');
    const files = collectProductionTsFiles(srcDir);
    const hits: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (/function spawnClaudeCodeProcess\(/.test(content)) hits.push(file);
    }
    expect(hits).toEqual([join(srcDir, 'sdk-engine.ts')]);
  });
});

// ---------------------------------------------------------------------------
// spawnClaudeCodeProcess -- delegates to node:child_process.spawn
// ---------------------------------------------------------------------------

describe('spawnClaudeCodeProcess', () => {
  it('spawns the given command via node:child_process.spawn and returns a kill/on-capable handle', async () => {
    const controller = new AbortController();
    const child = spawnClaudeCodeProcess({
      command: 'true',
      args: [],
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      signal: controller.signal,
    });
    expect(typeof child.kill).toBe('function');
    expect(typeof child.on).toBe('function');
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });
  });
});

// ---------------------------------------------------------------------------
// ready timing -- decoupled from system:init (Architect requirement 5)
// ---------------------------------------------------------------------------

describe('SdkEngine — ready timing (decoupled from system:init)', () => {
  it('emits ready synchronously even when the fake queryFn generator never yields anything (bug-polarity regression guard)', () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(neverYieldingGenerator);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    // Construction is synchronous. Against a hypothetical WRONG
    // implementation that gates `ready`'s emit call on having first
    // observed a system:init-shaped message (e.g. moving the emit into the
    // system:init handler), this assertion would fail -- the fake's
    // generator never yields anything, so that handler would never run and
    // `events` would stay empty. Against the actual (decoupled)
    // implementation, `ready` has already fired by the time
    // `new SdkEngine(...)` returns.
    expect(events).toEqual([{ v: 1, type: 'ready' }]);
  });

  it('emits sdk-session-id only once system:init has actually arrived via the background consumer, not synchronously at construction', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([systemInit()]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));

    expect(events).toEqual([{ v: 1, type: 'ready' }]);
    expect(eventsOfType(events, 'sdk-session-id')).toHaveLength(0);

    await flush();

    expect(eventsOfType(events, 'sdk-session-id')).toEqual([
      { v: 1, type: 'sdk-session-id', sdkSessionId: '22222222-2222-2222-2222-222222222222' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pin 2 -- tool-surface containment (S5), now a RUNTIME requirement
// ---------------------------------------------------------------------------

describe('SdkEngine — tool-surface containment (Pin 2, S5)', () => {
  it('accepts a system:init report whose non-mcp__ tools are a subset of the configured allowlist (positive control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'Glob', 'Grep', 'mcp__agent-console__close_session'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }));
    await flush();

    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
    expect(eventsOfType(events, 'sdk-session-id')).toHaveLength(1);
  });

  it('terminates the session with a fatal event when system:init reports a forbidden builtin tool outside the allowlist (negative control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, isClosed } = makeFakeQuery([
      systemInit({ tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'mcp__agent-console__close_session'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }));
    await flush();

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('WebFetch');
    expect(isClosed()).toBe(true);
  });

  it('excludes mcp__-prefixed entries from the containment subset check by design (an mcp__ tool never trips it)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__agent-console__anything_not_in_our_allowlist'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read'] }));
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('fails loudly (re-fatal) rather than hanging when runTurn is called after the engine was terminated by containment', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([systemInit({ tools: ['WebFetch'] })]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: [] }));
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(1);

    events.length = 0;
    await engine.runTurn('u2', 'hello again');
    expect(events).toEqual([
      { v: 1, type: 'fatal', message: 'SDK engine session already terminated; cannot start a new turn' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Event mapping (Appendix A.2)
// ---------------------------------------------------------------------------

describe('SdkEngine — event mapping (Appendix A.2)', () => {
  it('maps a text-only successful turn: assistant-delta accumulation, assistant-message, state active->idle', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      textDeltaEvent('Hel'),
      textDeltaEvent('lo!'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'assistant-delta')).toEqual([
      { v: 1, type: 'assistant-delta', turnId: 'u1', text: 'Hel' },
      { v: 1, type: 'assistant-delta', turnId: 'u1', text: 'lo!' },
    ]);
    expect(eventsOfType(events, 'assistant-message')).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'Hello!' },
    ]);
    expect(eventsOfType(events, 'turn-error')).toHaveLength(0);
    expect(eventsOfType(events, 'state').map((e) => e.state)).toEqual(['active', 'idle']);
  });

  it('emits assistant-message with empty text when a completed iteration has no text (tool-only response)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      assistantToolUseMessage('call-1', 'Read', { file_path: '/tmp/x' }),
      messageStopEvent(),
      userToolResultMessage('call-1', 'file contents'),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'assistant-message')).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: '' },
    ]);
  });

  it('emits tool-call immediately upon observing the assistant tool_use message, strictly before message_stop\'s assistant-message and before that call\'s own tool-result', async () => {
    // Replaces the old (wrong-assumption) expectation that tool-call was
    // buffered until message_stop, flushed AFTER assistant-message. A real
    // captured NDJSON transcript showed the SDK's tool_result echo can arrive
    // before the buffered tool-call was ever flushed -- see the bug-polarity
    // test below and docs/design/embedded-agent-sdk-engine.md Appendix A's
    // `tool-call` row correction trail.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      textDeltaEvent('Sure, let me check.'),
      assistantToolUseMessage('call-1', 'Read', { file_path: '/tmp/x' }),
      messageStopEvent(),
      userToolResultMessage('call-1', 'file contents'),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    const orderedTypes = events
      .filter((e) => e.type === 'assistant-message' || e.type === 'tool-call' || e.type === 'tool-result')
      .map((e) => e.type);
    // tool-call now precedes assistant-message (it is emitted at the
    // assistant tool_use message, before message_stop's flush), and both
    // precede this callId's own tool-result.
    expect(orderedTypes).toEqual(['tool-call', 'assistant-message', 'tool-result']);

    expect(eventsOfType(events, 'tool-call')).toEqual([
      { v: 1, type: 'tool-call', turnId: 'u1', callId: 'call-1', name: 'Read', args: { file_path: '/tmp/x' } },
    ]);
    expect(eventsOfType(events, 'tool-result')).toEqual([
      { v: 1, type: 'tool-result', turnId: 'u1', callId: 'call-1', ok: true, result: 'file contents' },
    ]);
  });

  // -------------------------------------------------------------------------
  // Bug-polarity: real captured NDJSON ordering (tool-result before tool-call)
  // -------------------------------------------------------------------------

  it('BUG POLARITY: reorders a tool-result that arrives before its tool-call, reproducing the real captured transcript ordering, instead of dropping it', async () => {
    // Fixture reproduces (as closely as the fake SDKMessage shapes allow) a
    // REAL captured NDJSON transcript from a live turn: the SDK's `user`
    // message carrying the Glob tool's tool_result arrived BEFORE the
    // `assistant` message describing that same tool_use block. Against the
    // OLD buffered-until-message_stop implementation, this test fails: the
    // unbuffered tool-result was emitted immediately with a callId the
    // client had never seen a tool-call for yet (client-side this produced
    // "tool-result for unknown callId, skipping" and permanently dropped the
    // result). Against the fix, the engine holds the early tool-result and
    // emits it right after its tool-call, in the correct order.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      textDeltaEvent("I don't have a generic \"Bash tool\" available in this environment"),
      textDeltaEvent('I can approximate "listing files in the current directory" using Glob instead.'),
      // tool_result arrives BEFORE the assistant message describing the call
      // -- the exact real-transcript ordering.
      userToolResultMessage('toolu_019kvWhbQ8czAhoY8K4Rz1Pe', '.git\n.claude/README.md\n...'),
      messageStopEvent(),
      assistantToolUseMessage('toolu_019kvWhbQ8czAhoY8K4Rz1Pe', 'Glob', { pattern: '*' }),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'list files');

    const orderedTypes = events
      .filter((e) => e.type === 'tool-call' || e.type === 'tool-result')
      .map((e) => e.type);
    // tool-call must precede tool-result on the OUTPUT stream, even though
    // the SDK's own wire order was the reverse.
    expect(orderedTypes).toEqual(['tool-call', 'tool-result']);

    expect(eventsOfType(events, 'tool-call')).toEqual([
      {
        v: 1,
        type: 'tool-call',
        turnId: 'u1',
        callId: 'toolu_019kvWhbQ8czAhoY8K4Rz1Pe',
        name: 'Glob',
        args: { pattern: '*' },
      },
    ]);
    expect(eventsOfType(events, 'tool-result')).toEqual([
      {
        v: 1,
        type: 'tool-result',
        turnId: 'u1',
        callId: 'toolu_019kvWhbQ8czAhoY8K4Rz1Pe',
        ok: true,
        result: '.git\n.claude/README.md\n...',
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Guard (Part B): adversarial synthetic ordering, reorders rather than
  // errors/drops
  // -------------------------------------------------------------------------

  it('GUARD: holds a tool-result queued for a callId with no tool-call yet, and flushes it in order once that tool-call is observed', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      // Adversarial synthetic ordering: the tool_result-shaped user message
      // arrives strictly before the assistant message describing the
      // tool_use it belongs to.
      userToolResultMessage('call-early', 'early result'),
      assistantToolUseMessage('call-early', 'Grep', { pattern: 'foo' }),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'search');

    const orderedTypes = events
      .filter((e) => e.type === 'tool-call' || e.type === 'tool-result')
      .map((e) => e.type);
    expect(orderedTypes).toEqual(['tool-call', 'tool-result']);
    expect(eventsOfType(events, 'tool-result')).toEqual([
      { v: 1, type: 'tool-result', turnId: 'u1', callId: 'call-early', ok: true, result: 'early result' },
    ]);
  });

  it('GUARD: a tool-result whose tool-call never arrives at all is still emitted (not dropped) once the turn ends', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      // Pathological case: this callId's tool-call never shows up in the
      // stream at all before the turn's `result` message.
      userToolResultMessage('call-orphan', 'orphan result'),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'search');

    expect(eventsOfType(events, 'tool-call')).toHaveLength(0);
    expect(eventsOfType(events, 'tool-result')).toEqual([
      { v: 1, type: 'tool-result', turnId: 'u1', callId: 'call-orphan', ok: true, result: 'orphan result' },
    ]);
  });

  it('maps a failed tool_result (is_error) to ok: false', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      assistantToolUseMessage('call-1', 'Read', {}),
      messageStopEvent(),
      userToolResultMessage('call-1', 'boom', true),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'tool-result')).toEqual([
      { v: 1, type: 'tool-result', turnId: 'u1', callId: 'call-1', ok: false, result: 'boom' },
    ]);
  });

  it('JSON.stringifies a non-string tool_result content (content-block array)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      assistantToolUseMessage('call-1', 'Read', {}),
      messageStopEvent(),
      userToolResultMessageWithBlockContent('call-1', [{ type: 'text', text: 'part' }]),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    const toolResult = eventsOfType(events, 'tool-result')[0];
    expect(toolResult.result).toBe(JSON.stringify([{ type: 'text', text: 'part' }]));
  });

  it('maps a thinking delta to assistant-thinking-delta without accumulating it into the assistant-message text', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      thinkingDeltaEvent('pondering...'),
      textDeltaEvent('Answer.'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'assistant-thinking-delta')).toEqual([
      { v: 1, type: 'assistant-thinking-delta', turnId: 'u1', text: 'pondering...' },
    ]);
    expect(eventsOfType(events, 'assistant-message')).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'Answer.' },
    ]);
  });

  it('ignores input_json_delta events entirely (no native counterpart)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      inputJsonDeltaEvent('{"partial":'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'assistant-delta')).toHaveLength(0);
    expect(eventsOfType(events, 'assistant-thinking-delta')).toHaveLength(0);
  });

  describe('turn-error subtype mapping', () => {
    const labeledCases: Array<
      ['error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries', string]
    > = [
      ['error_max_turns', 'SDK turn ended: maximum turns reached'],
      ['error_max_budget_usd', 'SDK turn ended: budget exceeded'],
      ['error_max_structured_output_retries', 'SDK turn ended: structured-output retries exhausted'],
    ];

    for (const [subtype, expectedMessage] of labeledCases) {
      it(`maps result subtype "${subtype}" to a labeled turn-error`, async () => {
        const events: EmbeddedAgentEvent[] = [];
        const { queryFn } = makeFakeQuery([systemInit(), resultError(subtype)]);
        const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
        await engine.runTurn('u1', 'hi');

        expect(eventsOfType(events, 'turn-error')).toEqual([
          { v: 1, type: 'turn-error', turnId: 'u1', message: expectedMessage },
        ]);
        expect(eventsOfType(events, 'state').map((e) => e.state)).toEqual(['active', 'idle']);
      });
    }

    it('maps error_during_execution with the joined errors array', async () => {
      const events: EmbeddedAgentEvent[] = [];
      const { queryFn } = makeFakeQuery([systemInit(), resultError('error_during_execution', ['boom', 'also this'])]);
      const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
      await engine.runTurn('u1', 'hi');

      expect(eventsOfType(events, 'turn-error')).toEqual([
        { v: 1, type: 'turn-error', turnId: 'u1', message: 'SDK turn failed: boom; also this' },
      ]);
    });

    it('falls back to a generic label when error_during_execution carries no errors', async () => {
      const events: EmbeddedAgentEvent[] = [];
      const { queryFn } = makeFakeQuery([systemInit(), resultError('error_during_execution', [])]);
      const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
      await engine.runTurn('u1', 'hi');

      expect(eventsOfType(events, 'turn-error')).toEqual([
        { v: 1, type: 'turn-error', turnId: 'u1', message: 'SDK turn failed: execution error' },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// handoff (Phase 2 stub)
// ---------------------------------------------------------------------------

describe('SdkEngine — handoff (Phase 2 not-yet-supported stub)', () => {
  it('emits active -> turn-error -> idle without throwing', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.handoff();

    expect(events.map((e) => e.type)).toEqual(['ready', 'state', 'turn-error', 'state']);
    expect(eventsOfType(events, 'state').map((e) => e.state)).toEqual(['active', 'idle']);
    expect(eventsOfType(events, 'turn-error')[0].message).toContain('Phase 2');
  });
});

// ---------------------------------------------------------------------------
// cancel / dispose
// ---------------------------------------------------------------------------

describe('SdkEngine — cancel', () => {
  it('fire-and-forget calls interrupt() on the underlying query', () => {
    const { queryFn, interruptCallCount } = makeFakeQuery([]);
    const engine = new SdkEngine(baseDeps({ queryFn }));
    engine.cancel();
    expect(interruptCallCount()).toBe(1);
  });

  it('is a no-op once the engine is dead', async () => {
    const { queryFn, interruptCallCount } = makeFakeQuery([systemInit({ tools: ['WebFetch'] })]);
    const engine = new SdkEngine(baseDeps({ queryFn, enabledTools: [] }));
    await flush();
    engine.cancel();
    expect(interruptCallCount()).toBe(0);
  });
});

describe('SdkEngine — dispose', () => {
  it('calls close() on the underlying SDK query', () => {
    const { queryFn, isClosed } = makeFakeQuery([]);
    const engine = new SdkEngine(baseDeps({ queryFn }));
    expect(isClosed()).toBe(false);
    engine.dispose();
    expect(isClosed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fatal path -- consumer-loop crash (transport/process failure)
// ---------------------------------------------------------------------------

describe('SdkEngine — fatal path (transport/process failure)', () => {
  function throwingGenerator(): AsyncGenerator<SDKMessage, void> {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      yield systemInit();
      throw new Error('transport exploded');
    }
    return gen();
  }

  it('emits fatal, disposes the query, and settles a pending turn when the consumer loop throws', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, isClosed } = makeFakeQuery(throwingGenerator);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    const turnPromise = engine.runTurn('u1', 'hi');
    await turnPromise; // must resolve (not hang) once handleFatal settles it

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('transport exploded');
    expect(isClosed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clean stream end (CodeRabbit fix, PR #1342) -- distinguishing an
// UNEXPECTED clean end (no throw, but also no `result` message -- e.g. the
// child `claude` process exited on its own) from a DELIBERATE one
// (`dispose()` closing the query, which also ends the stream).
// ---------------------------------------------------------------------------

describe('SdkEngine — clean stream end (unexpected vs deliberate)', () => {
  function cleanEndGenerator(): AsyncGenerator<SDKMessage, void> {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      yield systemInit();
      // Returns without throwing and without ever yielding a `result`
      // message -- models the SDK's message stream ending unexpectedly
      // (e.g. the child `claude` process exited on its own).
    }
    return gen();
  }

  it('emits fatal, marks the engine dead, and settles a pending turn when the message stream ends cleanly with no result message', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, isClosed } = makeFakeQuery(cleanEndGenerator);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    const turnPromise = engine.runTurn('u1', 'hi');
    await turnPromise; // must resolve (not hang) once handleFatal settles it

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toBe('SDK message stream ended unexpectedly');
    expect(isClosed()).toBe(true);

    // `dead` became true: a later runTurn is rejected loudly rather than
    // hanging (same re-fatal contract as the Pin 2 containment test above).
    events.length = 0;
    await engine.runTurn('u2', 'hello again');
    expect(events).toEqual([
      { v: 1, type: 'fatal', message: 'SDK engine session already terminated; cannot start a new turn' },
    ]);
  });

  it('does not emit an extra fatal when dispose() is called and the underlying query then also ends its stream (real close-triggers-stream-end sequence)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    let resolveClose: (() => void) | null = null;
    const closeSignal = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    let closeCallCount = 0;

    const queryFn: QueryFn = () => {
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        // Blocks here until dispose() -> query.close() resolves this --
        // mirrors the real SDK's stream ending as a direct consequence of
        // close(), not independently of it.
        await closeSignal;
      })();
      const fake = Object.assign(gen, {
        interrupt: async () => undefined,
        close: () => {
          closeCallCount++;
          resolveClose?.();
        },
      });
      return asQuery(fake);
    };

    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await flush();
    engine.dispose();
    await flush(); // let closeSignal resolve, the generator return, and consumeLoop's for-await exit

    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
    expect(closeCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Discriminant containment note
// ---------------------------------------------------------------------------

describe('SdkEngine — discriminant containment (compile-level)', () => {
  it('SdkEngineDeps carries no apiKey-shaped field, matching the claude-sdk init arm\'s provider shape', () => {
    // TypeScript-level guarantee: `SdkEngineDeps` only accepts `model:
    // string` for the provider surface (via `model: string` directly, not a
    // `provider` object at all) -- there is no `apiKey`/`baseUrl` field to
    // even declare. This test exists as a documented anchor for that static
    // guarantee; main.test.ts's wire-schema test covers the runtime half.
    const deps: SdkEngineDeps = baseDeps();
    expect('apiKey' in deps).toBe(false);
    expect('baseUrl' in deps).toBe(false);
  });
});
