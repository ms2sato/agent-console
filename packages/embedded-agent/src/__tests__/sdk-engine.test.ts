/**
 * Tests for the claude-sdk engine (docs/design/embedded-agent-sdk-engine.md,
 * Appendix A). Every test drives `SdkEngine` through the `queryFn` DI seam
 * with a fake replaying a scripted `SDKMessage` sequence -- no real `claude`
 * process is spawned. The one exception is the `spawnClaudeCodeProcess`
 * override test, which spawns a real short-lived process to prove the
 * override actually delegates to `node:child_process.spawn`.
 *
 * The sibling engine's own literal is `openai-api` (#1364; formerly
 * `native-loop`) -- production `sdk-engine.ts` only names it in comments, so
 * no assertion here changes.
 */

import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import { z } from 'zod';
import type { EmbeddedAgentAttachment, EmbeddedAgentEvent } from '@agent-console/shared';
import type {
  Options,
  Query,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  createSdkCompactTool,
  createSdkTodoWriteTool,
  SdkEngine,
  spawnClaudeCodeProcess,
  type SdkEngineDeps,
} from '../sdk-engine.js';
import { composeSdkSystemPromptAppend } from '../system-prompt.js';
import type { ActivationBlock, RuleActivatorLike } from '../rule-activation.js';
import { createTodoWriteTool } from '../tools/todo-write.js';

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

/**
 * The single, documented `as unknown as SDKControlGetContextUsageResponse`
 * escape hatch for this file's context-usage fixtures -- same rationale as
 * `asSdkMessage` above.
 */
function asContextUsage(value: Record<string, unknown>): SDKControlGetContextUsageResponse {
  return value as unknown as SDKControlGetContextUsageResponse;
}

/** A usable `getContextUsage()` response: has a finite `totalTokens`. */
function usableContextUsage(totalTokens: number): SDKControlGetContextUsageResponse {
  return asContextUsage({
    categories: [],
    totalTokens,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: (totalTokens / 200000) * 100,
    gridRows: [],
    model: 'claude-sonnet-5',
    memoryFiles: [],
    mcpTools: [],
  });
}

/** An UNUSABLE `getContextUsage()` response (S1): resolves, but with no
 * usable `totalTokens` field -- the skip-with-warn case, distinct from a
 * throw (H2's retry-with-settle case). */
function unusableContextUsage(): SDKControlGetContextUsageResponse {
  return asContextUsage({});
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
  contextUsageCallCount: () => number;
}

interface FakeQueryOpts {
  /** Defaults to an always-usable `{ totalTokens: 1000 }` response. Override
   * to test H2 retry/exhaustion (throw N times then resolve, or always
   * throw) or S1's skip-with-warn path (resolve with `unusableContextUsage()`). */
  getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
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
function makeFakeQuery(
  source: SDKMessage[] | (() => AsyncGenerator<SDKMessage, void>),
  opts: FakeQueryOpts = {},
): FakeQueryHandle {
  const captured: { options?: Options } = {};
  let closed = false;
  let interruptCalls = 0;
  let contextUsageCalls = 0;
  const getContextUsageImpl = opts.getContextUsage ?? (async () => usableContextUsage(1000));

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
      getContextUsage: async () => {
        contextUsageCalls++;
        return getContextUsageImpl();
      },
    });
    return asQuery(fake);
  };

  return {
    queryFn,
    captured,
    isClosed: () => closed,
    interruptCallCount: () => interruptCalls,
    contextUsageCallCount: () => contextUsageCalls,
  };
}

/**
 * A `queryFn` fake that ALSO drains the live prompt queue (`UserMessageQueue`
 * is private to `SdkEngine`, so this is the only way to observe what
 * `runTurn` pushed onto it) while replaying `source`'s canned messages to
 * carry a turn to completion the ordinary way.
 *
 * `source[0]` (conventionally `systemInit()`) is emitted immediately, mirroring
 * a real connection handshake that precedes any user turn. Every remaining
 * message in `source` is held until the FIRST message has actually arrived on
 * the prompt queue -- a real SDK cannot answer a turn it has not received yet,
 * and without this gate a scripted response that resolves the turn (a
 * `resultSuccess()`) could race ahead of an async attachment-resolution push
 * and settle `runTurn`'s promise before `pushedMessages` observes anything.
 */
function makeCapturingQuery(source: SDKMessage[]): { queryFn: QueryFn; pushedMessages: SDKUserMessage[] } {
  const pushedMessages: SDKUserMessage[] = [];
  const queryFn: QueryFn = (params) => {
    const promptIterator = (params.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const firstMessageArrived = (async () => {
      const { value } = await promptIterator.next();
      if (value) pushedMessages.push(value);
    })();
    // Drain any further pushes in the background; not exercised by this
    // file's single-turn scenarios, but keeps the fake queue from stalling.
    void (async () => {
      await firstMessageArrived;
      for (;;) {
        const { value, done } = await promptIterator.next();
        if (done) return;
        if (value) pushedMessages.push(value);
      }
    })();

    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      const [first, ...rest] = source;
      if (first) yield first;
      await firstMessageArrived;
      for (const m of rest) yield m;
      await new Promise<never>(() => {});
    })();
    const fake = Object.assign(gen, {
      interrupt: async () => undefined,
      close: () => {},
      getContextUsage: async () => usableContextUsage(1000),
    });
    return asQuery(fake);
  };
  return { queryFn, pushedMessages };
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

/** Instant, non-waiting default for the H2 settle sleep -- individual H2
 * tests override this to assert the actual delay/attempt-count contract;
 * every other test just needs turns to complete without real 500ms waits. */
function instantSleep(recorded: number[] = []): (ms: number) => Promise<void> {
  return async (ms) => {
    recorded.push(ms);
  };
}

/**
 * `JSON.stringify` over a live `query()` Options object, tolerant of the
 * cycles the in-process SDK MCP server instance introduces. Used only by the
 * "no apiKey-derived value anywhere in the options" containment assertions,
 * which must walk the whole structure -- checking only the fields we expect
 * would defeat the point of the check.
 */
function stringifyOptionsForContainment(options: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(options, (_key, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

/**
 * Default `RuleActivatorLike` for tests that are not about lazy rule
 * activation: never matches anything, and `activate()` is never expected to
 * be called against it (the PostToolUse hook only calls `activate` when
 * `matchScopedRules` returned a non-empty list). The dedicated "PostToolUse
 * hook: lazy rule activation" describe block below overrides this with a
 * fake that actually asserts call shape.
 */
function noopRuleActivator(): RuleActivatorLike {
  return {
    matchScopedRules: () => [],
    activate: async () => {
      throw new Error('activate() should never be called when matchScopedRules() returned []');
    },
  };
}

const baseDeps = (overrides: Partial<SdkEngineDeps> = {}): SdkEngineDeps => ({
  cwd: '/tmp/work',
  model: 'claude-sonnet-5',
  mcp: { baseUrl: 'http://mcp.local', token: 'tok-123' },
  emit: () => {},
  // Compaction: OFF by default so the SDK's own auto-compaction is not the
  // subject of tests that are about something else; the compaction describe
  // below opts in explicitly.
  autoCompaction: false,
  sleep: instantSleep(),
  ruleActivator: noopRuleActivator(),
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

/**
 * Finding #1 (#1572): an `assistant` SDKMessage carrying a TEXT content
 * block (as opposed to `assistantToolUseMessage`'s `tool_use` block). Used
 * both for the synthetic-reply shape (no preceding `stream_event` at all)
 * and, in the double-emit guard test, alongside real `textDeltaEvent`s.
 */
function assistantTextMessage(text: string): SDKMessage {
  return asSdkMessage({
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      type: 'message',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {},
      container: null,
      context_management: null,
      diagnostics: null,
      model: 'claude-sonnet-5',
      stop_details: null,
    },
    parent_tool_use_id: null,
    uuid: '11111111-1111-1111-1111-111111111121',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

/**
 * Finding #2 (#1572): the SDK's own `/clear`-shaped message -- a TOP-LEVEL
 * `conversation_reset`, not a `system` subtype.
 */
function conversationResetMessage(): SDKMessage {
  return asSdkMessage({
    type: 'conversation_reset',
    new_conversation_id: '33333333-3333-3333-3333-333333333333',
    uuid: '11111111-1111-1111-1111-111111111122',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

/**
 * An SDKMessage type this engine still has no mapping for -- used as the
 * "other unknown types are unaffected" control for Finding #2's
 * `conversation_reset` case.
 */
function rateLimitEventMessage(): SDKMessage {
  return asSdkMessage({
    type: 'rate_limit_event',
    uuid: '11111111-1111-1111-1111-111111111123',
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
  terminalReason?: string,
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
    ...(terminalReason !== undefined ? { terminal_reason: terminalReason } : {}),
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
    expect(options.mcpServers?.['agent-console']).toEqual({
      type: 'http',
      url: 'http://mcp.local',
      headers: { Authorization: 'Bearer tok-123' },
      alwaysLoad: true,
    });
    // Compaction's `Compact` tool is served by a SECOND, in-process SDK MCP
    // server. Asserted by presence rather than deep equality: the value is a
    // live server instance, not a config literal.
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(['agent-console', 'console']);
    // R1: the re-scoped Phase 1 pin. `resume` is absent because these deps
    // carried none -- NOT because the engine cannot pass one. The pin's
    // other half (present exactly when deps supplied one) is asserted in the
    // "re-scoped no-resume pin" block below; the two together are the
    // biconditional, and this half alone would pass against an engine with
    // no resume support at all.
    expect('resume' in options).toBe(false);
    // No apiKey-derived value anywhere in the constructed options: the
    // claude-sdk init arm's `provider` never carries one (enforced by the
    // shared discriminated schema -- see main.test.ts's containment test),
    // and this engine never reads or forwards such a field. Defensive
    // structural check on the actual constructed object, not just the type.
    expect(stringifyOptionsForContainment(options)).not.toContain('apiKey');
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
    // `Compact` rides along outside `enabledTools` -- see the empty-array
    // test below for the containment property this is one half of.
    expect(captured.options?.tools).toEqual(['Read', 'Bash', 'mcp__console__Compact']);
  });

  it('defaults options.tools to the read-only default set when enabledTools is absent', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));
    // `TodoWrite` is in the default enabled set (DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS),
    // so its MCP-namespaced name (Issue #1575) rides along after `Compact`'s,
    // in addition to the bare native name already present via `enabledToolNames`.
    expect(captured.options?.tools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'TodoWrite',
      'mcp__console__Compact',
      'mcp__console__TodoWrite',
    ]);
  });

  it('allowlists ONLY Compact when enabledTools is the explicit empty array', () => {
    // `enabledTools: []` is the strongest form of "every capability tool
    // off", and `Compact` survives it -- the containment property from
    // compact-tool.ts, asserted here at the SDK boundary where it takes
    // effect. No representable definition can remove it.
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: [] }));
    expect(captured.options?.tools).toEqual(['mcp__console__Compact']);
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
    const systemPromptAppend = composeSdkSystemPromptAppend({ segments }, 'Be terse.');
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
    const systemPromptAppend = composeSdkSystemPromptAppend({ segments: [] }, undefined);
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

  it('invokes the SDK query() function from exactly ONE production call site, in sdk-engine.ts', () => {
    // Phase 1 pinned this at one call site; Phase 2's handoff `reseed` added
    // a second; #1401 retired handoff and took the reseed with it, so
    // containment is exact again. The property guarded throughout is the
    // same: every call to the SDK's raw `query()` goes through
    // `this.queryFn(`, and `this.queryFn(` appears in NO file other than
    // sdk-engine.ts.
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

  // Issue #1573 observability: unknown/unavailable tool names in options.tools
  // are silently dropped by the resolved CLI rather than erroring (measured
  // against pinned SDK 0.3.238 -- `TodoWrite` is one such name) -- so the
  // reported system:init catalog is logged whenever TodoWrite was requested,
  // turning a future dogfood run's stderr into a free re-check of whether
  // that has changed.
  it('logs the reported system:init tool catalog when TodoWrite was requested', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { queryFn } = makeFakeQuery([systemInit({ tools: ['Read', 'Glob', 'Grep'] })]);
      new SdkEngine(baseDeps({ queryFn, enabledTools: ['Read', 'Glob', 'Grep', 'TodoWrite'] }));
      await flush();

      expect(warn).toHaveBeenCalledWith(
        '[sdk-engine] system:init tool catalog (TodoWrite requested): Read, Glob, Grep',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log the system:init tool catalog when TodoWrite was not requested', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { queryFn } = makeFakeQuery([systemInit({ tools: ['Read', 'Glob', 'Grep'] })]);
      new SdkEngine(baseDeps({ queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }));
      await flush();

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

    // #1495 R2/R3/R5 — `error_during_execution` splits on `terminal_reason`
    // into a canceled ending and a genuine-error ending, rather than always
    // surfacing the raw joined `errors` array. Each pin asserts the
    // CONSEQUENCE the classification drives, not only the copy (the e6
    // lesson in agent-loop-overflow-escape.test.ts): the canceled case is
    // proven by the ABSENCE of the genuine-error path's diagnostic-log
    // side effect, and the genuine-error case is proven by its PRESENCE.
    // A label-only implementation (return different text but always warn,
    // or never warn) fails one half of this pair.
    describe('error_during_execution: canceled vs. genuine error (#1495)', () => {
      it("terminal_reason 'aborted_streaming' -> canceled ending: friendly copy, no diagnostic preserved", async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const events: EmbeddedAgentEvent[] = [];
          const { queryFn } = makeFakeQuery([
            systemInit(),
            resultError('error_during_execution', ['[ede_diagnostic] result_type=user'], 'aborted_streaming'),
          ]);
          // enabledTools excludes TodoWrite here (unlike the default) so the
          // Issue #1573 system:init observability warn (see sdk-engine.ts's
          // handleSystemInit) does not pollute this spy -- this test is about
          // turn-error diagnostic preservation, not tool-catalog logging.
          const engine = new SdkEngine(
            baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }),
          );
          await engine.runTurn('u1', 'hi');

          expect(eventsOfType(events, 'turn-error')).toEqual([
            { v: 1, type: 'turn-error', turnId: 'u1', message: 'turn canceled' },
          ]);
          // The consequence: the genuine-error path's diagnostic-preservation
          // call never fires for a classified cancel. If classification
          // regressed to "always warn", this fails while the copy above
          // still reads correctly.
          expect(warn).not.toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      });

      it('a genuine error (no terminal_reason) -> friendly copy in the transcript, raw diagnostic preserved on stderr', async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const events: EmbeddedAgentEvent[] = [];
          const { queryFn } = makeFakeQuery([
            systemInit(),
            resultError('error_during_execution', ['boom', 'also this']),
          ]);
          // enabledTools excludes TodoWrite -- see the sibling test above for
          // why (Issue #1573 observability warn would otherwise pollute this
          // spy's call count).
          const engine = new SdkEngine(
            baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }),
          );
          await engine.runTurn('u1', 'hi');

          const turnErrors = eventsOfType(events, 'turn-error');
          expect(turnErrors).toHaveLength(1);
          // Friendly copy, never the raw diagnostic string, in the
          // user-visible transcript.
          expect(turnErrors[0].message).not.toContain('boom');
          expect(turnErrors[0].message).toBe('The turn ended in an error. See the server log for details.');
          // The consequence: the raw diagnostic is not silently swallowed --
          // it is preserved on a non-user channel (this subprocess's
          // stderr).
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0]?.[0]).toContain('boom; also this');
        } finally {
          warn.mockRestore();
        }
      });

      it('falls back to a generic label in the preserved diagnostic when error_during_execution carries no errors', async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const events: EmbeddedAgentEvent[] = [];
          const { queryFn } = makeFakeQuery([systemInit(), resultError('error_during_execution', [])]);
          // enabledTools excludes TodoWrite -- see the earlier test in this
          // describe block for why.
          const engine = new SdkEngine(
            baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }),
          );
          await engine.runTurn('u1', 'hi');

          expect(eventsOfType(events, 'turn-error')).toEqual([
            { v: 1, type: 'turn-error', turnId: 'u1', message: 'The turn ended in an error. See the server log for details.' },
          ]);
          expect(warn.mock.calls[0]?.[0]).toContain('execution error');
        } finally {
          warn.mockRestore();
        }
      });

      it("R5 fail-open: an unrecognized terminal_reason routes to the genuine-error path, never to canceled", async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const events: EmbeddedAgentEvent[] = [];
          const { queryFn } = makeFakeQuery([
            systemInit(),
            // A value the current TerminalReason union does not define --
            // stands in for a future SDK adding a new reason this engine
            // does not yet know about. Misclassifying THIS as a cancel would
            // hide a real failure; the pin proves it does not.
            resultError('error_during_execution', ['a future SDK reason'], 'some_future_reason'),
          ]);
          // enabledTools excludes TodoWrite -- see the first test in this
          // describe block for why.
          const engine = new SdkEngine(
            baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }),
          );
          await engine.runTurn('u1', 'hi');

          expect(eventsOfType(events, 'turn-error')).toEqual([
            { v: 1, type: 'turn-error', turnId: 'u1', message: 'The turn ended in an error. See the server log for details.' },
          ]);
          // The consequence, again: genuine-error's diagnostic preservation
          // fired, which canceled's path never does.
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0]?.[0]).toContain('a future SDK reason');
        } finally {
          warn.mockRestore();
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Finding #1 (#1572) -- synthetic local-command replies (no stream_event at
// all) must still reach the transcript via handleAssistantMessage's
// sawTextDelta-guarded fallback.
// ---------------------------------------------------------------------------

describe('SdkEngine — Finding #1 (#1572): synthetic-reply fallback in handleAssistantMessage', () => {
  it('emits assistant-message from a text-only assistant SDKMessage that arrived with NO preceding stream_event (synthetic reply)', async () => {
    // Required pin 1. Polarity: with the fallback removed (comment out the
    // `!this.sawTextDelta` block in handleAssistantMessage), this test fails
    // -- no assistant-message event is emitted at all, matching the bug the
    // rewritten COMPACT_SLASH_COMMAND comment describes.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      assistantTextMessage('Set model to Sonnet 5 for this session only'),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', '/model sonnet');

    expect(eventsOfType(events, 'assistant-message')).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'Set model to Sonnet 5 for this session only' },
    ]);
    // No delta ever streamed for this reply -- confirms the fallback path,
    // not the ordinary delta-accumulation path, produced the event.
    expect(eventsOfType(events, 'assistant-delta')).toHaveLength(0);
  });

  it('does NOT double-emit when a real delta-streamed turn is followed by the text block\'s own assistant SDKMessage', async () => {
    // Required pin 2 (no-double-emit guard). This is exactly the shape the
    // fallback must not fire for: `sawTextDelta` was set true by the real
    // deltas, so the text-carrying `assistant` SDKMessage below must be a
    // no-op for `assistant-message` emission, and message_stop's own
    // accumulated-text emit must be the ONLY one.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      textDeltaEvent('Hel'),
      textDeltaEvent('lo!'),
      assistantTextMessage('Hello!'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'assistant-message')).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'Hello!' },
    ]);
  });

  it('a /compact sent on an empty/short conversation (synthetic decline, no stream_event) reaches the transcript as an assistant-message row', async () => {
    // Required pin 3: the rewritten COMPACT_SLASH_COMMAND comment's claim,
    // pinned end-to-end through this file's existing runTurn harness.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit(),
      assistantTextMessage('Not enough messages to compact.'),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', '/compact');

    expect(eventsOfType(events, 'assistant-message')).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'Not enough messages to compact.' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Finding #3 (#1584, Architect review) -- does `sawTextDelta`'s
// per-`assistant`-SDKMessage reset double-emit `assistant-message` on a
// tool-using turn, where multiple `assistant` SDKMessages arrive within one
// turn (one per completed content block)? Driven by a REAL captured
// sequence, not a hand-authored one, so the interleaving of thinking / text /
// tool_use content blocks across `assistant` SDKMessages matches what the
// live SDK actually produces (see the fixture's own header note).
// ---------------------------------------------------------------------------

describe('SdkEngine — Finding #3 (#1584): no double-emit across a real tool-using turn', () => {
  it('emits exactly one tool-call and exactly two assistant-message events (one per message_stop boundary) for a real captured tool-using turn', async () => {
    // Fixture: packages/embedded-agent/src/__tests__/__fixtures__/tool-turn-real-sequence.ndjson
    // -- 37 real SDKMessages captured from a live claude-sdk conversation that
    // plants a secret number via a real `Read` tool call, then reports it.
    // Each `assistant` SDKMessage's `.content` array carries ONLY the
    // block(s) for that specific occurrence (thinking-only, text-only, or
    // tool_use-only) -- never cumulative -- which is exactly the shape that
    // would double-emit `assistant-message` if `sawTextDelta`'s reset were
    // wrong. Read via readFileSync + JSON.parse per line (NDJSON), fed
    // directly into makeFakeQuery -- no hand-authored fixture builders, so
    // this test cannot silently diverge from what the SDK actually sends.
    const fixturePath = join(import.meta.dir, '__fixtures__', 'tool-turn-real-sequence.ndjson');
    const rawLines = readFileSync(fixturePath, 'utf8').trim().split('\n');
    const messages = rawLines.map((line) => JSON.parse(line) as Record<string, unknown>);

    // The real capture's system:init reports the FULL agent-console tool
    // catalog (Task, Bash, EnterWorktree, ...) -- Pin 2's live containment
    // check (this file's own "SDK session reported disallowed tool(s)"
    // fatal path, unrelated to Finding #3) would otherwise terminate the
    // session before the turn under test even completes. Only the `Read`
    // tool the fixture's own tool_use block actually calls is relevant to
    // this test, so the fixture's system:init is adjusted to match the
    // engine's `enabledTools` below -- this narrows containment scope only,
    // and does not touch any of the assistant/tool_use/text content this
    // test asserts on.
    for (const message of messages) {
      if (message.type === 'system' && message.subtype === 'init') {
        message.tools = ['Read'];
      }
    }

    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(messages as unknown as SDKMessage[]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read'] }));
    await engine.runTurn('u1', 'What is the secret number in note.txt?');

    // Double-emission guard: at most (and, per the positive assertion below,
    // exactly) two assistant-message events -- one per message_stop boundary
    // in the fixture, never one per content block.
    const assistantMessages = eventsOfType(events, 'assistant-message');
    expect(assistantMessages.length).toBeLessThanOrEqual(2);
    expect(assistantMessages).toEqual([
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'Let me check that file.' },
      { v: 1, type: 'assistant-message', turnId: 'u1', text: 'The secret number is 99.' },
    ]);

    // Exactly one tool-call for the fixture's single real Read tool_use block.
    expect(eventsOfType(events, 'tool-call')).toEqual([
      {
        v: 1,
        type: 'tool-call',
        turnId: 'u1',
        callId: 'toolu_01AKNi4uvzRofJBkC7CXtx9m',
        name: 'Read',
        args: { file_path: 'note.txt' },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Finding #2 (#1572) -- `/clear`'s `conversation_reset`: declare the
// divergence instead of silently dropping it.
// ---------------------------------------------------------------------------

describe('SdkEngine — Finding #2 (#1572): conversation_reset declares the divergence', () => {
  it('maps a conversation_reset message to a turn-error naming the divergence', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([systemInit(), conversationResetMessage(), resultSuccess()]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', '/clear');

    expect(eventsOfType(events, 'turn-error')).toEqual([
      {
        v: 1,
        type: 'turn-error',
        turnId: 'u1',
        message: "SDK conversation was reset; the transcript above is no longer the model's memory",
      },
    ]);
  });

  it('leaves other still-unmapped message types silently ignored (control: conversation_reset handling did not widen the default case)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([systemInit(), rateLimitEventMessage(), resultSuccess()]);
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(eventsOfType(events, 'turn-error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S1 -- usage polling (turn-gated, H2-encoded)
// ---------------------------------------------------------------------------

describe('SdkEngine — context-usage polling (S1)', () => {
  it('polls getContextUsage exactly once after a completed turn and emits context-usage from totalTokens', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, contextUsageCallCount } = makeFakeQuery(
      [systemInit(), textDeltaEvent('hi'), messageStopEvent(), resultSuccess()],
      { getContextUsage: async () => usableContextUsage(4242) },
    );
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await engine.runTurn('u1', 'hi');

    expect(contextUsageCallCount()).toBe(1);
    expect(eventsOfType(events, 'context-usage')).toEqual([
      { v: 1, type: 'context-usage', promptTokens: 4242, estimated: false },
    ]);
  });

  it('never polls getContextUsage absent a completed turn (no timer/interval polling)', async () => {
    const { queryFn, contextUsageCallCount } = makeFakeQuery([systemInit()]);
    new SdkEngine(baseDeps({ queryFn }));
    await flush();
    expect(contextUsageCallCount()).toBe(0);
  });

  it('skip-with-warn (not fatal) when getContextUsage resolves without a usable totalTokens field', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { queryFn } = makeFakeQuery(
        [systemInit(), textDeltaEvent('hi'), messageStopEvent(), resultSuccess()],
        { getContextUsage: async () => unusableContextUsage() },
      );
      const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
      await engine.runTurn('u1', 'hi');

      expect(eventsOfType(events, 'context-usage')).toHaveLength(0);
      expect(eventsOfType(events, 'fatal')).toHaveLength(0);
      expect(eventsOfType(events, 'state').map((e) => e.state)).toEqual(['active', 'idle']);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('H2: retries with settle when getContextUsage throws the transport error, then succeeds within budget', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const { queryFn } = makeFakeQuery(
      [systemInit(), textDeltaEvent('hi'), messageStopEvent(), resultSuccess()],
      {
        getContextUsage: async () => {
          attempts++;
          if (attempts < 3) throw new Error('ProcessTransport is not ready for writing');
          return usableContextUsage(777);
        },
      },
    );
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, sleep: instantSleep(sleeps) }));
    await engine.runTurn('u1', 'hi');

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([500, 500]);
    expect(eventsOfType(events, 'context-usage')).toEqual([
      { v: 1, type: 'context-usage', promptTokens: 777, estimated: false },
    ]);
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('H2: emits fatal after exhausting the retry budget (>= 3 attempts spanning >= 2s), and disposes the session', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const { queryFn, isClosed } = makeFakeQuery(
      [systemInit(), textDeltaEvent('hi'), messageStopEvent(), resultSuccess()],
      {
        getContextUsage: async () => {
          attempts++;
          throw new Error('ProcessTransport is not ready for writing');
        },
      },
    );
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, sleep: instantSleep(sleeps) }));
    await engine.runTurn('u1', 'hi');

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(sleeps.length).toBe(attempts - 1);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('getContextUsage');
    // No spurious turn-error/state:idle emitted after the fatal.
    expect(eventsOfType(events, 'turn-error')).toHaveLength(0);
    expect(eventsOfType(events, 'state').map((e) => e.state)).toEqual(['active']);
    expect(isClosed()).toBe(true);

    events.length = 0;
    await engine.runTurn('u2', 'again');
    expect(events).toEqual([
      { v: 1, type: 'fatal', message: 'SDK engine session already terminated; cannot start a new turn' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// S2 -- PS1 tripwire (compaction detector) + PS2 must-not-assume containment
// ---------------------------------------------------------------------------

describe('SdkEngine — PS1 compaction tripwire (S2)', () => {
  function twoTurnMessages() {
    return [
      systemInit(),
      textDeltaEvent('one'),
      messageStopEvent(),
      resultSuccess(),
      textDeltaEvent('two'),
      messageStopEvent(),
      resultSuccess(),
    ];
  }

  it('BUG POLARITY: logs a loud warn naming PS1 when totalTokens drops by more than the material-drop ratio between polls', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let call = 0;
      const responses = [usableContextUsage(10000), usableContextUsage(1000)]; // 90% drop
      const { queryFn } = makeFakeQuery(twoTurnMessages(), {
        getContextUsage: async () => responses[call++],
      });
      const engine = new SdkEngine(baseDeps({ queryFn }));
      await engine.runTurn('u1', 'hi');
      await engine.runTurn('u2', 'hi');

      const ps1Warnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('PS1 tripwire'),
      );
      expect(ps1Warnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when totalTokens grows normally between polls', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let call = 0;
      const responses = [usableContextUsage(1000), usableContextUsage(1500)];
      const { queryFn } = makeFakeQuery(twoTurnMessages(), {
        getContextUsage: async () => responses[call++],
      });
      const engine = new SdkEngine(baseDeps({ queryFn }));
      await engine.runTurn('u1', 'hi');
      await engine.runTurn('u2', 'hi');

      const ps1Warnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('PS1 tripwire'),
      );
      expect(ps1Warnings.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn on a small (non-material) drop between polls', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let call = 0;
      const responses = [usableContextUsage(1000), usableContextUsage(900)]; // 10% drop, under the 20% ratio
      const { queryFn } = makeFakeQuery(twoTurnMessages(), {
        getContextUsage: async () => responses[call++],
      });
      const engine = new SdkEngine(baseDeps({ queryFn }));
      await engine.runTurn('u1', 'hi');
      await engine.runTurn('u2', 'hi');

      const ps1Warnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('PS1 tripwire'),
      );
      expect(ps1Warnings.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('SdkEngine — PS2 must-not-assume containment (S2)', () => {
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

  it('asserts "autoCompactWindow" appears in NO production source under packages/embedded-agent/src/', () => {
    const srcDir = join(import.meta.dir, '..');
    const files = collectProductionTsFiles(srcDir);
    const hits = files.filter((file) => readFileSync(file, 'utf8').includes('autoCompactWindow'));
    expect(hits).toEqual([]);
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

// ---------------------------------------------------------------------------
// Compaction (#1401)
// ---------------------------------------------------------------------------

function compactBoundary(
  metadata: {
    trigger?: 'manual' | 'auto';
    pre_tokens?: number;
    post_tokens?: number;
    // Either present means the SDK kept some messages rather than
    // summarising everything -- see the SDK's own doc comment on both
    // fields, quoted in `flushCompactionBoundary`'s doc comment.
    preserved_messages?: boolean;
    preserved_segment?: boolean;
  } = {},
): SDKMessage {
  return asSdkMessage({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: metadata.trigger ?? 'auto',
      pre_tokens: metadata.pre_tokens ?? 101565,
      ...(metadata.post_tokens !== undefined ? { post_tokens: metadata.post_tokens } : {}),
      ...(metadata.preserved_messages === true ? { preserved_messages: { uuids: ['msg-1'] } } : {}),
      ...(metadata.preserved_segment === true
        ? { preserved_segment: { anchor_uuid: 'msg-0', leaf_uuid: 'msg-1' } }
        : {}),
    },
    uuid: '11111111-1111-1111-1111-11111111111a',
    session_id: '22222222-2222-2222-2222-222222222222',
  });
}

/** Invokes the `PostCompact` hook wired into the captured options, exactly as
 * the SDK would. Returns false when no such hook was registered. */
async function firePostCompactHook(options: Options | undefined, summary: string): Promise<boolean> {
  const matchers = options?.hooks?.PostCompact;
  if (!matchers || matchers.length === 0) return false;
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      await hook(
        {
          hook_event_name: 'PostCompact',
          trigger: 'auto',
          compact_summary: summary,
          session_id: '22222222-2222-2222-2222-222222222222',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/work',
          permission_mode: 'bypassPermissions',
        } as Parameters<typeof hook>[0],
        undefined,
        { signal: new AbortController().signal },
      );
    }
  }
  return true;
}

/**
 * Invokes the `PostToolUse` hook wired into the captured options, exactly as
 * the SDK would for a real tool call. Returns `null` when no such hook was
 * registered (regression guard for the hook's own presence), otherwise the
 * `SyncHookJSONOutput` the callback returned.
 */
async function firePostToolUseHook(
  options: Options | undefined,
  toolName: string,
  toolInput: unknown,
): Promise<SyncHookJSONOutput | null> {
  const matchers = options?.hooks?.PostToolUse;
  if (!matchers || matchers.length === 0) return null;
  let last: SyncHookJSONOutput | null = null;
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      last = (await hook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: {},
          tool_use_id: 'call-1',
          session_id: '22222222-2222-2222-2222-222222222222',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/work',
          permission_mode: 'bypassPermissions',
        } as Parameters<typeof hook>[0],
        undefined,
        { signal: new AbortController().signal },
      )) as SyncHookJSONOutput;
    }
  }
  return last;
}

/**
 * A `RuleActivatorLike` fake that records every call and answers exactly
 * once per name in `matchOnce` -- mirrors the real `RuleActivator`'s
 * once-only contract (see rule-activation.ts) so this file's "second call
 * for the same rule" test does not need a real filesystem-backed activator
 * to exercise the wiring.
 */
function fakeRuleActivator(matchOnce: Record<string, string[]>, blockText = 'RULE BLOCK'): {
  activator: RuleActivatorLike;
  matchCalls: { toolName: string; args: unknown }[];
  activateCalls: string[][];
} {
  const matchCalls: { toolName: string; args: unknown }[] = [];
  const activateCalls: string[][] = [];
  const alreadyMatched = new Set<string>();
  const activator: RuleActivatorLike = {
    matchScopedRules: (toolName, args) => {
      matchCalls.push({ toolName, args });
      const names = (matchOnce[toolName] ?? []).filter((n) => !alreadyMatched.has(n));
      for (const n of names) alreadyMatched.add(n);
      return names;
    },
    activate: async (names) => {
      activateCalls.push(names);
      if (names.length === 0) return null;
      const block: ActivationBlock = { text: blockText, skippedForSize: [], activatedNames: names };
      return block;
    },
  };
  return { activator, matchCalls, activateCalls };
}

describe('SdkEngine — PostToolUse hook: lazy rule activation (#1343 Phase B, claude-sdk slice)', () => {
  it('registers a PostToolUse entry in options.hooks', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));
    expect(captured.options?.hooks?.PostToolUse).toBeDefined();
    expect(captured.options?.hooks?.PostToolUse?.length).toBeGreaterThan(0);
  });

  it('returns the activation block as additionalContext for a matching tool_input.file_path', async () => {
    const { activator, matchCalls, activateCalls } = fakeRuleActivator({ Read: ['workflow'] }, 'THE RULE TEXT');
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, ruleActivator: activator }));

    const result = await firePostToolUseHook(captured.options, 'Read', { file_path: 'src/x.ts' });

    expect(matchCalls).toEqual([{ toolName: 'Read', args: { file_path: 'src/x.ts' } }]);
    expect(activateCalls).toEqual([['workflow']]);
    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'THE RULE TEXT' },
    });
  });

  it('returns { continue: true } with no hookSpecificOutput for a non-matching tool_input', async () => {
    const { activator, activateCalls } = fakeRuleActivator({ Read: ['workflow'] });
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, ruleActivator: activator }));

    // A Bash call: `RuleActivator.matchScopedRules` never matches Bash, by
    // construction (R3) -- this fake mirrors that via `matchOnce` having no
    // 'Bash' key.
    const result = await firePostToolUseHook(captured.options, 'Bash', { command: 'ls' });

    expect(activateCalls).toEqual([]);
    expect(result).toEqual({ continue: true });
  });

  it('returns { continue: true } with no hookSpecificOutput the SECOND time for an already-activated rule', async () => {
    const { activator, activateCalls } = fakeRuleActivator({ Read: ['workflow'] });
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, ruleActivator: activator }));

    const first = await firePostToolUseHook(captured.options, 'Read', { file_path: 'src/x.ts' });
    const second = await firePostToolUseHook(captured.options, 'Read', { file_path: 'src/y.ts' });

    expect(first?.hookSpecificOutput).toBeDefined();
    expect(activateCalls).toEqual([['workflow']]);
    expect(second).toEqual({ continue: true });
  });
});

describe('SdkEngine — compaction: the auto toggle', () => {
  it('composes the worker toggle into the SDK settings, ON', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, autoCompaction: true }));
    expect(captured.options?.settings).toEqual({ autoCompactEnabled: true });
  });

  it('composes the worker toggle into the SDK settings, OFF', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, autoCompaction: false }));
    expect(captured.options?.settings).toEqual({ autoCompactEnabled: false });
  });

  it('applies a live toggle change to the running session via applyFlagSettings', () => {
    // Live rather than at-next-activation because probe #1400 P1a measured
    // the mid-session write actually taking effect.
    const applied: unknown[] = [];
    const { queryFn } = makeFakeQuery([]);
    const wrappedQueryFn: QueryFn = (params) => {
      const q = queryFn(params);
      return asQuery(
        Object.assign(q, {
          applyFlagSettings: async (settings: unknown) => {
            applied.push(settings);
          },
        }),
      );
    };
    const engine = new SdkEngine(baseDeps({ queryFn: wrappedQueryFn, autoCompaction: false }));

    engine.setAutoCompaction(true);

    expect(applied).toEqual([{ autoCompactEnabled: true }]);
  });

  it('does not throw when the live write fails -- the durable value still applies at the next activation', async () => {
    const { queryFn } = makeFakeQuery([]);
    const wrappedQueryFn: QueryFn = (params) => {
      const q = queryFn(params);
      return asQuery(
        Object.assign(q, {
          applyFlagSettings: async () => {
            throw new Error('transport gone');
          },
        }),
      );
    };
    const engine = new SdkEngine(baseDeps({ queryFn: wrappedQueryFn, autoCompaction: false }));

    expect(() => engine.setAutoCompaction(true)).not.toThrow();
    await flush();
  });
});

describe('SdkEngine — compaction: the boundary marker', () => {
  it('emits context-compacted with the summary when the PostCompact hook delivered one', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, captured } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary({ trigger: 'auto', pre_tokens: 101565, post_tokens: 25367 });
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));
    const turn = engine.runTurn('u1', 'hello');

    // The hook path is independent of the iterator; fire it before the
    // boundary reaches `result`, which is one of the two orderings.
    await flush();
    expect(await firePostCompactHook(captured.options, 'THE SDK SUMMARY')).toBe(true);
    await turn;

    expect(eventsOfType(events, 'context-compacted')).toEqual([
      {
        v: 1,
        type: 'context-compacted',
        source: 'auto',
        summary: 'THE SDK SUMMARY',
        preTokens: 101565,
        postTokens: 25367,
        coverage: 'full',
      },
    ]);
  });

  it('STILL emits the marker when no summary ever arrives -- a missing summary must not swallow the boundary', async () => {
    // The load-bearing polarity. The summary and the boundary travel on
    // independent paths whose relative order is not a contract we have
    // measured, and `PostCompact` was probed opportunistically -- so "the
    // summary never came" has to degrade to a marker without a summary, not
    // to silence. A compaction that happened and left no trace in the
    // transcript is the failure this test exists to prevent.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary({ trigger: 'manual', pre_tokens: 25331, post_tokens: 2033 });
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    await engine.runTurn('u1', 'hello');

    const markers = eventsOfType(events, 'context-compacted');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      source: 'manual',
      preTokens: 25331,
      postTokens: 2033,
      coverage: 'full',
    });
    expect('summary' in markers[0]).toBe(false);
  });

  it('omits the token pair when the SDK reports no post_tokens, rather than inventing one', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary({ trigger: 'auto', pre_tokens: 101565 });
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    await engine.runTurn('u1', 'hello');

    const marker = eventsOfType(events, 'context-compacted')[0];
    expect(marker).toBeDefined();
    expect('preTokens' in marker).toBe(false);
    expect('postTokens' in marker).toBe(false);
  });

  it("coverage: 'partial' when the SDK's compact_metadata carries preserved_messages -- some messages were kept, not summarised", async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary({ trigger: 'auto', preserved_messages: true });
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    await engine.runTurn('u1', 'hello');

    const marker = eventsOfType(events, 'context-compacted')[0];
    expect(marker).toMatchObject({ coverage: 'partial' });
  });

  it("coverage: 'partial' when the SDK's compact_metadata carries preserved_segment (the field preserved_messages supersedes)", async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary({ trigger: 'auto', preserved_segment: true });
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    await engine.runTurn('u1', 'hello');

    const marker = eventsOfType(events, 'context-compacted')[0];
    expect(marker).toMatchObject({ coverage: 'partial' });
  });

  it("coverage: 'full' when neither preserved field is present -- the SDK summarised everything", async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary({ trigger: 'auto' });
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    await engine.runTurn('u1', 'hello');

    const marker = eventsOfType(events, 'context-compacted')[0];
    expect(marker).toMatchObject({ coverage: 'full' });
  });

  it('emits the marker once, before the turn ends, and not again on the next turn', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield compactBoundary();
        yield resultSuccess();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    await engine.runTurn('u1', 'hello');
    const types = events.map((e) => e.type);
    expect(types.indexOf('context-compacted')).toBeLessThan(types.lastIndexOf('state'));

    events.length = 0;
    await engine.runTurn('u2', 'again');
    expect(eventsOfType(events, 'context-compacted')).toHaveLength(0);
  });
});

describe('SdkEngine — compaction: the PS1 tripwire, made mode-aware', () => {
  const usage = (total: number) => async () => usableContextUsage(total);

  async function runTwoTurns(opts: {
    autoCompaction: boolean;
    totals: [number, number];
    boundaryOnSecondTurn: boolean;
  }): Promise<void> {
    let call = 0;
    const { queryFn } = makeFakeQuery(
      () =>
        (async function* (): AsyncGenerator<SDKMessage, void> {
          yield systemInit();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          yield resultSuccess();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (opts.boundaryOnSecondTurn) yield compactBoundary();
          yield resultSuccess();
          await new Promise<never>(() => {});
        })(),
      { getContextUsage: async () => usage(opts.totals[Math.min(call++, 1)])() },
    );
    const engine = new SdkEngine(baseDeps({ queryFn, autoCompaction: opts.autoCompaction }));
    await engine.runTurn('u1', 'first');
    await engine.runTurn('u2', 'second');
  }

  it('OFF + material drop + no boundary -> WARNS (the original PS1 violation)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runTwoTurns({ autoCompaction: false, totals: [100000, 20000], boundaryOnSecondTurn: false });
      expect(warn.mock.calls.some(([m]) => String(m).includes('PS1 tripwire'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('ON + material drop + boundary -> SILENT (this is the feature working)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runTwoTurns({ autoCompaction: true, totals: [100000, 20000], boundaryOnSecondTurn: true });
      expect(warn.mock.calls.some(([m]) => String(m).includes('PS1 tripwire'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('ON + material drop + NO boundary -> STILL WARNS (unexplained shrinkage is an anomaly in either mode)', async () => {
    // This quadrant is the entire reason the tripwire is not simply deleted
    // once the toggle is on.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runTwoTurns({ autoCompaction: true, totals: [100000, 20000], boundaryOnSecondTurn: false });
      expect(warn.mock.calls.some(([m]) => String(m).includes('PS1 tripwire'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('no material drop -> SILENT, in either mode', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runTwoTurns({ autoCompaction: true, totals: [100000, 95000], boundaryOnSecondTurn: false });
      await runTwoTurns({ autoCompaction: false, totals: [100000, 95000], boundaryOnSecondTurn: false });
      expect(warn.mock.calls.some(([m]) => String(m).includes('PS1 tripwire'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SdkEngine — compaction: the Compact tool', () => {
  it('registers an in-process SDK MCP server and allowlists the namespaced tool name', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: [] }));

    expect(captured.options?.mcpServers?.['console']).toBeDefined();
    expect(captured.options?.tools).toContain('mcp__console__Compact');
  });

  it("the tool's handler reserves, and answers with the same wording the openai-api engine uses", async () => {
    let reserved = 0;
    const definition = createSdkCompactTool(() => {
      reserved++;
    });

    expect(definition.name).toBe('Compact');
    const result = await definition.handler({}, undefined);

    expect(reserved).toBe(1);
    expect(JSON.stringify(result)).toContain('Compaction scheduled; runs when this turn completes.');
  });

  it('sends /compact at the turn boundary, never mid-turn', async () => {
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess();
        // The injected `/compact`'s own terminal result. `await turn` below
        // does not resolve without it -- the turn is held open across the
        // compaction on purpose.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const pushed: string[] = [];
    const engine = new SdkEngine(baseDeps({ queryFn }));
    // Observe what reaches the SDK's own input queue.
    const queue = (engine as unknown as { queue: { push: (m: { message: { content: string } }) => void } }).queue;
    const originalPush = queue.push.bind(queue);
    queue.push = (m) => {
      pushed.push(m.message.content);
      originalPush(m);
    };

    const turn = engine.runTurn('u1', 'please compact');
    engine.reserveCompaction();
    // Nothing sent yet: compaction never runs mid-turn.
    expect(pushed).toEqual(['please compact']);

    await turn;
    expect(pushed).toEqual(['please compact', '/compact']);
  });

  it("attributes the injected /compact turn's events to the RESERVING turn, by decision", async () => {
    // Wire semantics, persisted forever, so it is pinned rather than left to
    // fall out of `currentTurnId` never being reassigned. The alternative --
    // minting a fresh id here -- would produce an assistant bubble belonging
    // to no user message at all, because the injected `/compact` deliberately
    // has no `user-message` row. See drainPendingCompactCommand's doc comment.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess();
        // The SDK's response to the injected /compact.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield textDeltaEvent('compacting now');
        yield messageStopEvent();
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    const turn = engine.runTurn('RESERVING-TURN', 'please compact');
    engine.reserveCompaction();
    await turn;
    await flush();
    await flush();

    const injected = eventsOfType(events, 'assistant-message').filter((e) =>
      e.text.includes('compacting now'),
    );
    expect(injected).toHaveLength(1);
    expect(injected[0].turnId).toBe('RESERVING-TURN');
  });

  it('holds the reserving turn open until the injected /compact reaches its own result', async () => {
    // The STRUCTURAL half of the attribution contract pinned above. That test
    // asserts the injected events carry the reserving turn's id; this one
    // asserts the only reason they can. `main.ts` keeps `turnActive` set for
    // as long as `runTurn` is unsettled, so holding the turn open across the
    // compaction is what makes a `user-message` mid-compaction impossible --
    // and with it, any reassignment of `currentTurnId` underneath the
    // injected turn. Settle before draining (the previous order) and the
    // attribution held only while nobody typed.
    let releaseCompactResult!: () => void;
    const compactResult = new Promise<void>((resolve) => {
      releaseCompactResult = resolve;
    });
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess(); // the reserving turn's own result
        await compactResult; // ... the injected /compact is in flight here
        yield resultSuccess(); // the injected /compact's result
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn }));

    let settled = false;
    const turn = engine.runTurn('u1', 'please compact').then(() => {
      settled = true;
    });
    engine.reserveCompaction();
    await flush();
    await flush();

    // The reserving turn's result has been consumed, yet the turn is NOT over.
    expect(settled).toBe(false);

    releaseCompactResult();
    await turn;
    expect(settled).toBe(true);
  });

  it('settles the turn when a booked compaction cannot be queued', async () => {
    // `drainPendingCompactCommand` reports whether it actually queued the
    // command, and `handleResult` holds the turn open ONLY on true. Otherwise
    // a booked compaction that never became a queued message would leave the
    // turn waiting for a result nobody will produce.
    //
    // Driven directly rather than through `handleResult`: the caller already
    // returns early on `this.dead` immediately before the drain, with no
    // `await` between the two, so this branch is not reachable from that path
    // today. It is pinned as the drain's own contract, which is what
    // `handleResult` relies on -- and what would silently rot if a future
    // `await` were introduced above it.
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn }));
    const internals = engine as unknown as {
      pendingCompactCommand: boolean;
      dead: boolean;
      drainPendingCompactCommand: () => boolean;
    };

    engine.reserveCompaction();
    internals.dead = true;

    expect(internals.drainPendingCompactCommand()).toBe(false);
    // The reservation is consumed either way, so a later pass cannot re-enter
    // the held-open branch on a stale flag.
    expect(internals.pendingCompactCommand).toBe(false);
  });

  it('DISCARDS the reservation on cancel', async () => {
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const pushed: string[] = [];
    const engine = new SdkEngine(baseDeps({ queryFn }));
    const queue = (engine as unknown as { queue: { push: (m: { message: { content: string } }) => void } }).queue;
    const originalPush = queue.push.bind(queue);
    queue.push = (m) => {
      pushed.push(m.message.content);
      originalPush(m);
    };

    const turn = engine.runTurn('u1', 'compact then cancel');
    engine.reserveCompaction();
    engine.cancel();
    // This `await` is a guard, not a wait. Since `handleResult` now holds the
    // turn open whenever a compaction is still booked, a cancel that failed to
    // discard the reservation would leave this turn deferred forever and the
    // test would fail on bun:test's timeout rather than on an assertion. That
    // is observed behaviour, not a hope: implementing the deferral made two
    // sibling tests in this file fail exactly that way until their fake
    // streams supplied the injected command's own result. Do not "simplify"
    // this await away -- it is the only thing asserting that cancel cannot
    // strand a turn.
    await turn;

    expect(pushed).toEqual(['compact then cancel']);
  });

  it('DISCARDS the reservation on dispose', async () => {
    const { queryFn } = makeFakeQuery([]);
    const engine = new SdkEngine(baseDeps({ queryFn }));

    engine.reserveCompaction();
    engine.dispose();

    expect(
      (engine as unknown as { pendingCompactCommand: boolean }).pendingCompactCommand,
    ).toBe(false);
  });

  it('a conversation too short to compact produces an ordinary assistant refusal and NO marker -- nothing hangs', async () => {
    // Probe #1400 recorded this: the SDK answers `/compact` on a short
    // conversation with "Not enough messages to compact." as normal
    // assistant output and emits no `compact_boundary`. That is the SDK
    // declining, not the command being absent -- and NOT a bug to compensate
    // for. The refusal is visible in the transcript where the user can read
    // it, which is the whole handling this case needs.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(() =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        yield systemInit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield resultSuccess();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yield textDeltaEvent('Not enough messages to compact.');
        yield messageStopEvent();
        yield resultSuccess();
        await new Promise<never>(() => {});
      })(),
    );
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    const turn = engine.runTurn('u1', 'please compact');
    engine.reserveCompaction();
    await turn;

    // The `/compact` went out and the refusal came back as ordinary assistant
    // output INSIDE the reserving turn -- the turn is held open across the
    // compaction, so no second `runTurn` is needed to collect it.
    expect(eventsOfType(events, 'context-compacted')).toHaveLength(0);
    expect(
      eventsOfType(events, 'assistant-message').some((e) =>
        e.text.includes('Not enough messages to compact.'),
      ),
    ).toBe(true);
    // Nothing hangs and nothing settles twice: the refusal's result reaches
    // the ordinary tail exactly once. A `/compact` the SDK declines is still
    // a terminal result, which is why no timeout guard is needed here.
    expect(eventsOfType(events, 'state').filter((e) => e.state === 'idle')).toHaveLength(1);
  });
});

describe('SdkEngine — TodoWrite, MCP-served (Issue #1575)', () => {
  it('registers the namespaced tool name in options.tools when TodoWrite is enabled (default)', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));

    expect(captured.options?.mcpServers?.['console']).toBeDefined();
    expect(captured.options?.tools).toContain('mcp__console__TodoWrite');
    // The bare native name stays in the array too -- deliberate, see
    // buildOptions()'s comment: a future SDK that starts natively
    // recognizing it is still caught by handleSystemInit's existing warn.
    expect(captured.options?.tools).toContain('TodoWrite');
  });

  it('does NOT register the namespaced tool name when TodoWrite is not in enabledTools', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: ['Read', 'Bash'] }));

    expect(captured.options?.tools).not.toContain('mcp__console__TodoWrite');
    expect(captured.options?.tools).toEqual(['Read', 'Bash', 'mcp__console__Compact']);
  });

  it('does NOT register the namespaced tool name when enabledTools is the explicit empty array', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: [] }));

    expect(captured.options?.tools).toEqual(['mcp__console__Compact']);
  });

  it("the tool's handler validates with the SAME schema and gives the SAME message as the openai-api builtin for structurally-valid-but-content-invalid input", async () => {
    // `todos` here is a structurally valid array of objects (passes the SDK
    // schema's top-level shape, see createSdkTodoWriteTool's doc comment),
    // but `status` is not one of the picklist values -- a CONTENT violation
    // the schema's z.unknown() leaves alone, so it reaches the handler's own
    // v.safeParse(TodoWriteArgsSchema, ...) call, the same one the
    // openai-api builtin uses.
    const malformed = { todos: [{ content: 'A', status: 'blocked', activeForm: 'Doing A' }] };

    const sdkDefinition = createSdkTodoWriteTool();
    const sdkResult = (await sdkDefinition.handler(malformed, undefined)) as {
      content: { type: 'text'; text: string }[];
      isError?: boolean;
    };

    const openaiTool = createTodoWriteTool();
    const openaiResult = await openaiTool.execute(malformed, {} as never);

    expect(sdkResult.isError).toBe(true);
    expect(openaiResult.ok).toBe(false);
    expect(sdkResult.content[0]?.text).toBe(openaiResult.result);
  });

  it('rejects a STRUCTURALLY invalid payload (todos not an array at all) at the schema level, before the handler ever runs -- a different, earlier-caught failure than the content-validation case above (Issue #1575)', async () => {
    // The SDK's own MCP request-handling validates a raw zod shape by
    // wrapping it with z.object(...) and calling .safeParseAsync(...) on the
    // incoming args BEFORE the registered handler is invoked (this is the
    // same wrapping z.object() itself performs on a ZodRawShape, and matches
    // what was observed inspecting the vendored SDK's tool-call validation
    // path). createSdkTodoWriteTool's returned definition exposes exactly
    // the raw shape that was handed to the SDK's tool() factory, so
    // reconstructing that same z.object(...) wrapper here exercises the
    // production schema through the identical mechanism the SDK itself
    // uses -- not a hand-rolled duplicate of TodoWriteArgsSchema's own
    // validation logic.
    const sdkDefinition = createSdkTodoWriteTool();
    const schema = z.object(sdkDefinition.inputSchema);

    // This is the exact live-reproduced failure shape from Issue #1575: the
    // model sent `todos` as a JSON-stringified array instead of a native one.
    const structurallyInvalid = {
      todos: '[{"content":"A","activeForm":"Doing A","status":"pending"}]',
    };

    const result = await schema.safeParseAsync(structurallyInvalid);

    expect(result.success).toBe(false);
  });

  it("the tool's handler returns the SAME summary text format as the openai-api builtin for valid input", async () => {
    const todos = [{ content: 'Run tests', status: 'in_progress' as const, activeForm: 'Running tests' }];

    const sdkDefinition = createSdkTodoWriteTool();
    const sdkResult = (await sdkDefinition.handler({ todos }, undefined)) as {
      content: { type: 'text'; text: string }[];
      isError?: boolean;
    };

    const openaiTool = createTodoWriteTool();
    const openaiResult = await openaiTool.execute({ todos }, {} as never);

    expect(sdkResult.isError).toBeUndefined();
    expect(openaiResult.ok).toBe(true);
    expect(sdkResult.content[0]?.text).toBe(openaiResult.result);
    expect(sdkResult.content[0]?.text).toBe('Todo list updated: 1 items (0 pending, 1 in progress, 0 completed)');
  });

  it('replaces the whole list on each call (full replace, not merge)', async () => {
    const sdkDefinition = createSdkTodoWriteTool();
    await sdkDefinition.handler(
      { todos: [{ content: 'A', status: 'pending' as const, activeForm: 'Doing A' }] },
      undefined,
    );
    const second = (await sdkDefinition.handler({ todos: [] }, undefined)) as {
      content: { type: 'text'; text: string }[];
    };
    expect(second.content[0]?.text).toBe('Todo list updated: 0 items (0 pending, 0 in progress, 0 completed)');
  });

  it('state does not leak across independent closures (fresh per incarnation, mirroring the openai-api builtin)', async () => {
    const first = createSdkTodoWriteTool();
    await first.handler(
      { todos: [{ content: 'A', status: 'pending' as const, activeForm: 'Doing A' }] },
      undefined,
    );

    const second = createSdkTodoWriteTool();
    const secondResult = (await second.handler({ todos: [] }, undefined)) as {
      content: { type: 'text'; text: string }[];
    };
    // A fresh instance starts with an empty list -- if state leaked via a
    // shared module-level variable, this would read "1 items" from `first`.
    expect(secondResult.content[0]?.text).toBe('Todo list updated: 0 items (0 pending, 0 in progress, 0 completed)');
  });
});

// ---------------------------------------------------------------------------
// Transcript Restore, R1 (#1410)
// ---------------------------------------------------------------------------

describe('SdkEngine — the re-scoped no-resume pin (R1)', () => {
  // Appendix A's init row: `resume` appears in query() options IF AND ONLY IF
  // it came from deps. The old pin asserted only "never present", which would
  // pass against an engine that had no resume support at all -- exactly the
  // state R1 changes. Both directions are asserted so neither a lost resume
  // nor an invented one can slip through.
  it('passes `resume` through to query() options when deps carry one', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, resume: 'sess-abc' }));
    expect(captured.options?.resume).toBe('sess-abc');
  });

  it('omits the `resume` key entirely when deps carry none', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));
    // Absent, not `undefined`: a present-but-undefined key is a different
    // thing to hand an SDK than no key at all.
    expect('resume' in (captured.options as object)).toBe(false);
  });

  it('never derives a resume id of its own from the SDK session it observes', async () => {
    // The other half of the re-scoped pin: the engine has no source for a
    // resume id except deps. Observing a `system:init` that reports a session
    // id must not turn into a `resume` on the options it built.
    const { queryFn, captured } = makeFakeQuery([systemInit({ sessionId: 'observed-session' })]);
    new SdkEngine(baseDeps({ queryFn }));
    await flush();
    expect('resume' in (captured.options as object)).toBe(false);
    expect(stringifyOptionsForContainment(captured.options)).not.toContain('observed-session');
  });
});

describe('SdkEngine — effort override (agent-surface.md Ruling 3, #1554)', () => {
  it('passes `effort` through to query() options when deps carry one', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, effort: 'high' }));
    expect(captured.options?.effort).toBe('high');
  });

  it('omits the `effort` key entirely when deps carry none', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn }));
    // Absent, not `undefined`: a present-but-undefined key is a different
    // thing to hand an SDK than no key at all -- mirrors the `resume` pin
    // above (Object.hasOwn / `in` distinguishes what a plain
    // `toBeUndefined()` on the value cannot).
    expect(Object.hasOwn(captured.options as object, 'effort')).toBe(false);
  });
});

describe('SdkEngine — a resume the SDK refuses (R1, PS6)', () => {
  // The detector is structural: resume was requested AND no `system:init` ever
  // arrived. Measured shape (design doc §5, PS6): no system:init, one
  // `error_during_execution` result, then the iterator throws.
  function refusedResumeScript(): () => AsyncGenerator<SDKMessage, void> {
    return async function* () {
      yield resultError('error_during_execution', []);
      throw new Error('Claude Code returned an error result: No conversation found with session ID: sess-gone');
    };
  }

  it('emits sdk-resume-failed and a resume-specific turn-error when no system:init ever arrived', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(refusedResumeScript());
    const engine = new SdkEngine(
      baseDeps({ queryFn, resume: 'sess-gone', emit: (e) => events.push(e) }),
    );
    void engine.runTurn('t1', 'hello');
    await flush();

    const failures = eventsOfType(events, 'sdk-resume-failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ requestedSdkSessionId: 'sess-gone', reason: 'refused' });

    // The human-readable half names the cause and asks for a resend, and
    // promises no recovery (the same prohibition the compaction marker
    // carries).
    const turnErrors = eventsOfType(events, 'turn-error');
    expect(turnErrors).toHaveLength(1);
    expect(turnErrors[0].message).toContain('Could not resume the previous session');
    expect(turnErrors[0].message).toContain('send your message again');
  });

  it('does NOT report a refused resume when a system:init was seen first', async () => {
    // The discriminating case, and the reason the detector cannot key on the
    // result subtype: an ordinary `interrupt()` produces the SAME
    // `error_during_execution` subtype. What separates them is that a cancel
    // always has a system:init behind it -- a turn was running.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([systemInit(), resultError('error_during_execution', ['aborted'])]);
    const engine = new SdkEngine(
      baseDeps({ queryFn, resume: 'sess-live', emit: (e) => events.push(e) }),
    );
    void engine.runTurn('t1', 'hello');
    await flush();

    expect(eventsOfType(events, 'sdk-resume-failed')).toHaveLength(0);
    // The turn still errors -- it just errors as itself, with the SDK's own
    // message rather than the resume wording.
    const turnErrors = eventsOfType(events, 'turn-error');
    expect(turnErrors).toHaveLength(1);
    expect(turnErrors[0].message).not.toContain('Could not resume');
  });

  it('does NOT report a refused resume when no resume was requested', async () => {
    // A fresh session that errors before system:init is a failure, but not
    // THIS failure -- there was nothing to resume.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(refusedResumeScript());
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));
    void engine.runTurn('t1', 'hello');
    await flush();

    expect(eventsOfType(events, 'sdk-resume-failed')).toHaveLength(0);
    const turnErrors = eventsOfType(events, 'turn-error');
    expect(turnErrors[0]?.message).not.toContain('Could not resume');
  });

  it('reports the refusal exactly once even though both the result and the throw observe it', async () => {
    // The failure is visible from two places -- the error `result` and the
    // throw the iterator raises straight after. The server ACTS on this
    // event (it replaces the incarnation), so a second copy would drive a
    // second recovery against the replacement.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(refusedResumeScript());
    const engine = new SdkEngine(
      baseDeps({ queryFn, resume: 'sess-gone', emit: (e) => events.push(e) }),
    );
    void engine.runTurn('t1', 'hello');
    await flush();
    await flush();

    expect(eventsOfType(events, 'sdk-resume-failed')).toHaveLength(1);
  });

  it('reports the refusal even when no turn was ever started', async () => {
    // A resume can be refused with nothing pushed onto the queue, in which
    // case there is no `result` for handleResult to see and only the
    // consumeLoop catch observes it. Without that arm the failure would be
    // silent on this path.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery(async function* () {
      throw new Error('Claude Code returned an error result: No conversation found with session ID: sess-gone');
    });
    new SdkEngine(baseDeps({ queryFn, resume: 'sess-gone', emit: (e) => events.push(e) }));
    await flush();

    const failures = eventsOfType(events, 'sdk-resume-failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ requestedSdkSessionId: 'sess-gone', reason: 'refused' });
  });
});

describe('SdkEngine — image attachments (#1571, confined to runTurn)', () => {
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(join(os.tmpdir(), 'sdk-engine-attach-'));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('pushes text+image content blocks (Anthropic shapes) for a turn with one PNG attachment', async () => {
    const filePath = join(rootDir, 'shot.png');
    await fsPromises.writeFile(filePath, PNG_BYTES);
    const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'image/png' }];

    const { queryFn, pushedMessages } = makeCapturingQuery([
      systemInit(),
      textDeltaEvent('I see it'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ queryFn, attachmentRoots: [rootDir] }));
    await engine.runTurn('u1', 'what is in this image?', attachments);

    expect(pushedMessages).toHaveLength(1);
    expect(pushedMessages[0].message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES.toString('base64') },
        },
      ],
    });
  });

  it('pushes a plain string, byte-identical to pre-#1571 behavior, for a turn with no attachments', async () => {
    const { queryFn, pushedMessages } = makeCapturingQuery([
      systemInit(),
      textDeltaEvent('ok'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const engine = new SdkEngine(baseDeps({ queryFn, attachmentRoots: [rootDir] }));
    await engine.runTurn('u1', 'hello there');

    expect(pushedMessages).toHaveLength(1);
    // Explicit shape comparison against the old
    // `{ role: 'user', content: text }` construction, not merely
    // `typeof === 'string'` -- the polarity requirement.
    expect(pushedMessages[0].message).toEqual({ role: 'user', content: 'hello there' });
  });

  it('never pushes onto the queue and settles as canceled when cancel() lands during attachment resolution', async () => {
    const filePath = join(rootDir, 'shot.png');
    await fsPromises.writeFile(filePath, PNG_BYTES);
    const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'image/png' }];

    const { queryFn, pushedMessages } = makeCapturingQuery([
      systemInit(),
      textDeltaEvent('second turn ok'),
      messageStopEvent(),
      resultSuccess(),
    ]);
    const events: EmbeddedAgentEvent[] = [];
    const engine = new SdkEngine(
      baseDeps({ queryFn, attachmentRoots: [rootDir], emit: (e) => events.push(e) }),
    );

    const turnPromise = engine.runTurn('u1', 'what is in this image?', attachments);
    // Synchronous, no await in between: `runTurn`'s detached IIFE has already
    // reached the real fs-read gap inside `resolveImageAttachments` by the
    // time `runTurn`'s own synchronous prefix returns control here, so
    // cancel() lands on the pending attachment resolution rather than after
    // it.
    engine.cancel();
    await turnPromise;

    // The message never reached the live SDK queue.
    expect(pushedMessages).toHaveLength(0);
    expect(eventsOfType(events, 'turn-error')).toEqual([
      { v: 1, type: 'turn-error', turnId: 'u1', message: 'turn canceled' },
    ]);
    const stateEvents = eventsOfType(events, 'state').map((e) => e.state);
    expect(stateEvents).toEqual(['active', 'idle']);

    // A subsequent turn for a new turn id is accepted normally -- the
    // canceled turn settled `currentTurnDeferred` and did not leave the
    // engine wedged.
    await engine.runTurn('u2', 'second turn');
    expect(pushedMessages).toHaveLength(1);
    expect(pushedMessages[0].message).toEqual({ role: 'user', content: 'second turn' });
  });
});

// ---------------------------------------------------------------------------
// Mid-run model / reasoning-effort / context-window change
// ---------------------------------------------------------------------------

/**
 * agent-surface.md Phase 3: `SdkEngine.setModelParams`.
 *
 * Both parameters apply LIVE on this engine -- `setModel` for the model,
 * `applyFlagSettings({ effortLevel })` for the effort -- so `applied: true` is
 * the ordinary outcome and no caller has to model a restart.
 *
 * Measured reach (each mutation applied alone, whole file re-run):
 * - dropping the `await this.query.setModel(...)` call -> 2 failures (the
 *   live-write test, and the model-rejection test, which then has nothing
 *   left to reject).
 * - dropping the `await this.query.applyFlagSettings(...)` call -> 3 failures
 *   (live-write, clear, and the effort-rejection test).
 * - passing `effortLevel: effortLevel ?? undefined` instead of the raw `null`
 *   -> 1 failure, the clear test, on `toBeNull()`. An `undefined` there is
 *   dropped by JSON serialization, so the flag layer would keep a stale
 *   effort: the silent no-op that assertion exists to catch, and the reason
 *   the shape of the assertion (not just its subject) is load-bearing.
 * - emitting `applied: true` unconditionally after the try/catch -> 2
 *   failures, both rejection tests.
 * - removing the `this.dead` early return -> 1 failure, the disposed-engine
 *   test, on the SDK having been called AND on `applied` being true.
 */
describe('SdkEngine — setModelParams (agent-surface.md Phase 3)', () => {
  interface LiveWriteHandle {
    queryFn: QueryFn;
    setModelCalls: (string | undefined)[];
    flagSettings: Record<string, unknown>[];
  }

  /** Wraps `makeFakeQuery`'s fake with the two live-write methods this engine
   * calls (neither is part of the base fake, which only implements what other
   * describes need), optionally making one of them reject. */
  function makeLiveWriteQuery(
    opts: { failOn?: 'setModel' | 'applyFlagSettings' } = {},
  ): LiveWriteHandle {
    const setModelCalls: (string | undefined)[] = [];
    const flagSettings: Record<string, unknown>[] = [];
    const { queryFn: base } = makeFakeQuery([]);
    const queryFn: QueryFn = (params) =>
      asQuery(
        Object.assign(base(params), {
          setModel: async (model?: string) => {
            setModelCalls.push(model);
            if (opts.failOn === 'setModel') throw new Error('transport gone');
          },
          applyFlagSettings: async (settings: Record<string, unknown>) => {
            flagSettings.push(settings);
            if (opts.failOn === 'applyFlagSettings') throw new Error('transport gone');
          },
        }),
      );
    return { queryFn, setModelCalls, flagSettings };
  }

  it('writes the new model and the new effort to the live session, then reports applied', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, setModelCalls, flagSettings } = makeLiveWriteQuery();
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    engine.setModelParams({ model: 'claude-opus-5', reasoningEffort: 'medium', contextWindowTokens: 120000 });
    await flush();

    expect(setModelCalls).toEqual(['claude-opus-5']);
    expect(flagSettings).toEqual([{ effortLevel: 'medium' }]);
    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: true },
    ]);
  });

  it('clears the effort with an explicit null -- NOT undefined, which the SDK drops in serialization (a silent no-op)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, flagSettings } = makeLiveWriteQuery();
    const engine = new SdkEngine(
      baseDeps({ queryFn, effort: 'low', emit: (e) => events.push(e) }),
    );

    engine.setModelParams({ model: 'claude-sonnet-5', reasoningEffort: null, contextWindowTokens: null });
    await flush();

    expect(flagSettings).toHaveLength(1);
    // The load-bearing assertion of this whole describe: `toBeNull()` fails
    // for `undefined`, where a `toBeUndefined()`/`toEqual` pair would not
    // distinguish the two. `null` clears the flag layer; `undefined` is
    // dropped by JSON serialization and leaves the previous effort in place.
    expect(flagSettings[0].effortLevel).toBeNull();
    expect('effortLevel' in flagSettings[0]).toBe(true);
    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: true },
    ]);
  });

  it('reports applied: false when a live write rejects -- the persisted values still apply at the next activation', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeLiveWriteQuery({ failOn: 'applyFlagSettings' });
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    expect(() =>
      engine.setModelParams({ model: 'claude-opus-5', reasoningEffort: 'high', contextWindowTokens: null }),
    ).not.toThrow();
    await flush();

    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: false },
    ]);
  });

  it('reports applied: false when the model write rejects, and does not attempt the effort write after it', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, flagSettings } = makeLiveWriteQuery({ failOn: 'setModel' });
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    engine.setModelParams({ model: 'claude-opus-5', reasoningEffort: 'high', contextWindowTokens: null });
    await flush();

    expect(flagSettings).toEqual([]);
    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: false },
    ]);
  });

  it('reports applied: false and touches the SDK not at all once the engine is dead', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, setModelCalls, flagSettings } = makeLiveWriteQuery();
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));
    engine.dispose();

    engine.setModelParams({ model: 'claude-opus-5', reasoningEffort: 'high', contextWindowTokens: 120000 });
    await flush();

    expect(setModelCalls).toEqual([]);
    expect(flagSettings).toEqual([]);
    // "Not live", never "not saved": the server persisted the row before
    // sending the command, and the next activation reads it.
    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: false },
    ]);
  });
});
