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
  McpServerConfig,
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

/**
 * A `queryFn` fake supporting `setMcpServers`/`mcpServerStatus` PLUS manual,
 * out-of-band message pushing (`push`) -- for tests that need to drive a
 * live `setMcpServers` call and THEN observe a later `system:init` occurrence
 * against the resulting (extended) containment expectation, which
 * `makeFakeQuery`'s fixed-array replay cannot express (the array is
 * exhausted/blocked before the test's own live call happens).
 */
function makeControllableMcpQuery(
  opts: { failOnCallNumber?: number } = {},
): {
  queryFn: QueryFn;
  push: (msg: SDKMessage) => void;
  setMcpServersCalls: Array<Record<string, unknown>>;
} {
  const queue: SDKMessage[] = [];
  let waiter: ((msg: SDKMessage) => void) | null = null;
  const push = (msg: SDKMessage) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(msg);
    } else {
      queue.push(msg);
    }
  };
  const setMcpServersCalls: Array<Record<string, unknown>> = [];
  let callCount = 0;
  const queryFn: QueryFn = () => {
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        const msg = await new Promise<SDKMessage>((resolve) => {
          waiter = resolve;
        });
        yield msg;
      }
    })();
    const fake = Object.assign(gen, {
      interrupt: async () => undefined,
      close: () => {},
      getContextUsage: async () => usableContextUsage(1000),
      setMcpServers: async (servers: Record<string, unknown>) => {
        setMcpServersCalls.push(servers);
        callCount += 1;
        // Selective per-call failure (`opts.failOnCallNumber`), distinct
        // from `makeLiveMcpWriteQuery`'s `failOn` which fails EVERY call --
        // needed by tests that must observe a SUCCESSFUL prior call's
        // effect surviving a LATER call's failure.
        if (opts.failOnCallNumber === callCount) throw new Error('transport gone');
        return { added: Object.keys(servers), removed: [], errors: {} };
      },
      mcpServerStatus: async () => [],
    });
    return asQuery(fake);
  };
  return { queryFn, push, setMcpServersCalls };
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
  // The per-user claude.ai connectors toggle: OFF by default (connectors
  // ON) so it is not the subject of tests that are about something else;
  // the dedicated describe block below opts in explicitly.
  disableClaudeAiConnectors: false,
  sleep: instantSleep(),
  ruleActivator: noopRuleActivator(),
  // epic #1636 Phase 5 PR-2 (Architect ruling B): empty by default so the
  // vast majority of tests, which are not about MCP discovery/agents at all,
  // see no discovered project servers, no initially-allowed pairs, an
  // available-but-empty user/local name set, and no subagents. The dedicated
  // describe blocks below override these explicitly.
  discoveredProjectMcpServers: new Map(),
  initialAllowedProjectMcpServers: [],
  expectedMcpServerNames: { userLocal: new Set(), unavailable: false },
  agents: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// SDKMessage fixture builders -- minimally populated (only the fields this
// engine actually reads), routed through `asSdkMessage` (see "Fixture cast
// escape hatches" above) since the real SDK types carry dozens of unrelated
// required fields this codebase does not own.
// ---------------------------------------------------------------------------

function systemInit(
  overrides: {
    sessionId?: string;
    tools?: string[];
    mcpServers?: { name: string; status: string }[];
  } = {},
): SDKMessage {
  return asSdkMessage({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: '2.1.233',
    cwd: '/tmp/work',
    tools: overrides.tools ?? ['Read', 'Glob', 'Grep'],
    mcp_servers: overrides.mcpServers ?? [{ name: 'agent-console', status: 'connected' }],
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

describe('SdkEngine — kind (Phase 4, #1683 decision 5)', () => {
  it("is 'claude-sdk', matching ClaudeSdkEngine's discriminant", () => {
    const { queryFn } = makeFakeQuery([]);
    const engine = new SdkEngine(baseDeps({ queryFn }));
    expect(engine.kind).toBe('claude-sdk');
  });
});

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
    // epic #1636 Phase 5 PR-2, design II (§4.5): the CLI's own User- and
    // Local-scope discovery replaces the Phase 1 `[]` value -- PS10 measured
    // `['user','local']` loads neither `.mcp.json` nor project CLAUDE.md/
    // rules/agents, so `'project'` stays deliberately absent.
    expect(options.settingSources).toEqual(['user', 'local']);
    expect('strictMcpConfig' in options).toBe(false);
    // Reach measured: removing autoMemoryEnabled from buildOptions fails this line with "expected {…} to equal {…}".
    expect(options.settings).toEqual({
      autoCompactEnabled: false,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: false,
    });
    expect(options.mcpServers?.['agent-console']).toEqual({
      type: 'http',
      url: 'http://mcp.local',
      headers: { Authorization: 'Bearer tok-123' },
      alwaysLoad: true,
    });
    // Compaction's `Compact` tool is served by a SECOND, in-process SDK MCP
    // server. Asserted by presence rather than deep equality: the value is a
    // live server instance, not a config literal. `baseDeps()` defaults
    // `projectMcpServers` to `{}`, so the reserved pair is the whole set here
    // -- the "plus project servers" half is asserted in the dedicated
    // `projectMcpServers` describe block below.
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
  // definition system prompt, and -- since Issue #1694 (C5) -- the
  // no-configuration case still sets `systemPrompt.append`, because the
  // identity preamble is always composed (the engine-level "omits
  // systemPrompt entirely" test above stays valid for a caller that passes
  // no append at all; main.ts is no longer such a caller).
  const sdkContext = { sessionId: 'sess-sdk', workerId: 'work-sdk', cwd: '/tmp/work' };
  it('carries composed opt-in instruction content into options.systemPrompt.append, ordered after the identity preamble and before the definition system prompt', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    const segments = [{ origin: '/tmp/work/NOTES.md', content: 'INSTRUCTION_CONTENT' }];
    const systemPromptAppend = composeSdkSystemPromptAppend({
      context: sdkContext,
      instructions: { segments },
      definitionSystemPrompt: 'Be terse.',
    });
    new SdkEngine(baseDeps({ queryFn, systemPromptAppend }));

    expect(captured.options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    });
    const append = (captured.options?.systemPrompt as { append: string }).append;
    const preambleIdx = append.indexOf('Session ID: sess-sdk');
    const instructionIdx = append.indexOf('INSTRUCTION_CONTENT');
    const definitionIdx = append.indexOf('Be terse.');
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(instructionIdx).toBeGreaterThan(preambleIdx);
    expect(definitionIdx).toBeGreaterThan(instructionIdx);
  });

  it('still sets systemPrompt.append (the identity preamble) when neither instructions nor a definition system prompt are configured (Issue #1694 C5)', () => {
    // Reach measured: reverting `composeSdkSystemPromptAppend` to the
    // pre-#1694 "return undefined when nothing to append" shape fails here
    // (append absent) -- the exact gap C5 closes: a Bash-less claude-sdk
    // worker with no instructions and no definition prompt had NO identity
    // source at all.
    const { queryFn, captured } = makeFakeQuery([]);
    const systemPromptAppend = composeSdkSystemPromptAppend({ context: sdkContext, instructions: { segments: [] } });

    new SdkEngine(baseDeps({ queryFn, systemPromptAppend }));
    expect(captured.options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    });
    expect(systemPromptAppend).toContain('Session ID: sess-sdk');
    expect(systemPromptAppend).toContain('Worker ID: work-sdk');
  });
});

// ---------------------------------------------------------------------------
// epic #1636 Phase 5 PR-2: buildOptions -- project MCP servers and subagents
// ---------------------------------------------------------------------------

describe('SdkEngine — buildOptions: project MCP servers and subagents (epic #1636 Phase 5 PR-2, Architect ruling B)', () => {
  it('resolves initialAllowedProjectMcpServers against discoveredProjectMcpServers and spreads the result into mcpServers alongside the reserved pair', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    const projectServer: McpServerConfig = { type: 'stdio', command: 'echo-server' };
    new SdkEngine(
      baseDeps({
        queryFn,
        discoveredProjectMcpServers: new Map([['my-server', { hash: 'h1', config: projectServer }]]),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
      }),
    );

    expect(Object.keys(captured.options?.mcpServers ?? {}).sort()).toEqual([
      'agent-console',
      'console',
      'my-server',
    ]);
    expect(captured.options?.mcpServers?.['my-server']).toEqual(projectServer);
  });

  it('silently skips an initialAllowedProjectMcpServers pair whose hash does not match the discovered entry', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(
      baseDeps({
        queryFn,
        discoveredProjectMcpServers: new Map([
          ['my-server', { hash: 'DIFFERENT', config: { type: 'stdio', command: 'echo-server' } }],
        ]),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
      }),
    );

    expect(Object.keys(captured.options?.mcpServers ?? {}).sort()).toEqual(['agent-console', 'console']);
  });

  it('silently skips an initialAllowedProjectMcpServers pair naming an undiscovered server', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(
      baseDeps({
        queryFn,
        discoveredProjectMcpServers: new Map(),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
      }),
    );

    expect(Object.keys(captured.options?.mcpServers ?? {}).sort()).toEqual(['agent-console', 'console']);
  });

  it('throws at construction if the resolved initial project servers contain the reserved "agent-console" name (defensive pin, not a production path)', () => {
    const { queryFn } = makeFakeQuery([]);
    expect(() =>
      new SdkEngine(
        baseDeps({
          queryFn,
          discoveredProjectMcpServers: new Map([
            ['agent-console', { hash: 'h1', config: { type: 'stdio', command: 'x' } }],
          ]),
          initialAllowedProjectMcpServers: [{ name: 'agent-console', hash: 'h1' }],
        }),
      ),
    ).toThrow(/reserved name "agent-console"/);
  });

  it('throws at construction if the resolved initial project servers contain the reserved "console" name (defensive pin, not a production path)', () => {
    const { queryFn } = makeFakeQuery([]);
    expect(() =>
      new SdkEngine(
        baseDeps({
          queryFn,
          discoveredProjectMcpServers: new Map([
            ['console', { hash: 'h1', config: { type: 'stdio', command: 'x' } }],
          ]),
          initialAllowedProjectMcpServers: [{ name: 'console', hash: 'h1' }],
        }),
      ),
    ).toThrow(/reserved name "console"/);
  });

  it('omits the agents key entirely when Task is not enabled, even when deps.agents is non-empty', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(
      baseDeps({
        queryFn,
        enabledTools: ['Read'],
        agents: { reviewer: { description: 'reviews code', prompt: 'You review code.' } },
      }),
    );
    expect('agents' in (captured.options ?? {})).toBe(false);
  });

  it('passes deps.agents through Options.agents when Task is enabled', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    const agents = { reviewer: { description: 'reviews code', prompt: 'You review code.' } };
    new SdkEngine(baseDeps({ queryFn, enabledTools: ['Read', 'Task'], agents }));
    expect(captured.options?.agents).toEqual(agents);
  });

  it('passes an empty agents object through when Task is enabled but discovery found nothing', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, enabledTools: ['Task'], agents: {} }));
    expect(captured.options?.agents).toEqual({});
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
      // `mcp__agent_console__...` (underscore form): this test exercises the
      // tool-surface containment check (Pin 2, S5), not the MCP wall's
      // hyphen-alphabet distinction (see `sdk-engine.ts`'s "MCP server
      // containment wall" describe block below for the real, hyphen-kept
      // `mcp__agent-console__...` form the CLI actually reports).
      // `classifyMcpServerScope`'s `'tool'` channel slugifies BOTH the known
      // name and this extracted name before comparing them, so either
      // spelling classifies as reserved here.
      systemInit({ tools: ['Read', 'Glob', 'Grep', 'mcp__agent_console__close_session'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read', 'Glob', 'Grep'] }));
    await flush();

    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
    expect(eventsOfType(events, 'sdk-session-id')).toHaveLength(1);
  });

  it('terminates the session with a fatal event when system:init reports a forbidden builtin tool outside the allowlist (negative control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, isClosed } = makeFakeQuery([
      systemInit({ tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'mcp__agent_console__close_session'] }),
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
      systemInit({ tools: ['Read', 'mcp__agent_console__anything_not_in_our_allowlist'] }),
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
// epic #1636 Phase 5 PR-2 (§4.5 D-E): the MCP server containment wall
// ---------------------------------------------------------------------------

describe('SdkEngine — MCP server containment wall (epic #1636 Phase 5 PR-2, §4.5 D-E)', () => {
  it('accepts a connector name in mcp_servers (label form) with no matching tool prefix (positive control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'claude.ai Google Drive', status: 'connected' },
        ],
      }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('accepts a connector tool-name prefix (already-slugified form) with no matching mcp_servers entry (positive control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__claude_ai_Google_Drive__list_files'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read'] }));
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  // Architect finding, 2026-09-21 (production-bricking regression fix on top
  // of the prior `classifyMcpServerScope` revision): `agent-console` is the
  // RESERVED, ALWAYS-PRESENT built-in server, so EVERY real `claude-sdk`
  // activation's `system:init` reports a tool named `mcp__agent-console__...`
  // for it -- and the CLI does NOT slugify `-` in its tool-name prefixes
  // (only `.` and spaces), so this tool name is reported with the hyphen
  // KEPT, never as `mcp__agent_console__...`. A one-sided tool-channel
  // comparison (`slugifyMcpServerName(known) === name`, without also
  // slugifying `name`) never matches `'agent_console' !== 'agent-console'`
  // and FATALS this activation -- i.e. every real one. This is the single
  // highest-priority pin in this file.
  //
  // Polarity, measured: reverting `classifyMcpServerScope`'s `'tool'`-channel
  // comparison to the one-sided form (`slugifyMcpServerName(known) === name`)
  // makes this pin FAIL with a fatal event naming `agent-console`. Restored
  // afterward.
  it('accepts the reserved agent-console server reported via its real, hyphen-kept mcp__agent-console__ tool-name form (positive control, Architect finding 2026-09-21)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__agent-console__list_sessions'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read'] }));
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('accepts a project server name resolved into the initial project MCP servers (positive control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'my-server', status: 'connected' },
        ],
        // `mcp__my-server__...` (HYPHEN KEPT, not `mcp__my_server__...`):
        // measured against 82 recorded real tool-name occurrences (Architect
        // finding, 2026-09-21), the CLI's own tool-name slugification does
        // NOT touch `-` -- only `.` and spaces collapse to `_`. A prior
        // version of this fixture used the underscore form on the mistaken
        // premise that the CLI slugifies hyphens too; that premise is false,
        // and a comparison built on it fatals the reserved `agent-console`
        // server (see the pin directly above this one).
        //
        // Polarity, measured: reverting `classifyMcpServerScope`'s
        // `'tool'`-channel comparison to the one-sided form
        // (`slugifyMcpServerName(known) === name`) makes THIS pin fail too
        // (1 fatal event naming `my-server` instead of 0) -- the hyphen-drop
        // bug is not specific to the reserved pair, it fatals any
        // hyphenated project-scope server's own tools as well. Restored
        // afterward.
        tools: ['Read', 'mcp__my-server__do_thing'],
      }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        enabledTools: ['Read'],
        discoveredProjectMcpServers: new Map([
          ['my-server', { hash: 'h1', config: { type: 'stdio', command: 'echo' } }],
        ]),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
      }),
    );
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('accepts a user/local-scope server name present in deps.expectedMcpServerNames.userLocal (positive control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'chrome-devtools', status: 'connected' },
        ],
      }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        expectedMcpServerNames: { userLocal: new Set(['chrome-devtools']), unavailable: false },
      }),
    );
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  // Architect finding, 2026-09-21: a real, commonly-configured Local-scope
  // MCP server (`chrome-devtools`) reported via its real, hyphen-kept
  // `mcp__chrome-devtools__...` tool-name form must also be accepted on the
  // `'tool'` channel, not only via the raw `mcp_servers[].name` channel
  // already covered by the positive control directly above.
  //
  // Polarity, measured: reverting `classifyMcpServerScope`'s `'tool'`-channel
  // comparison to the one-sided form makes this pin FAIL with a fatal event
  // naming `chrome-devtools`. Restored afterward.
  it('accepts a user/local-scope server reported via its real, hyphen-kept mcp__chrome-devtools__ tool-name form (positive control, Architect finding 2026-09-21)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__chrome-devtools__list_pages'] }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        enabledTools: ['Read'],
        expectedMcpServerNames: { userLocal: new Set(['chrome-devtools']), unavailable: false },
      }),
    );
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('terminates with a fatal event when mcp_servers reports a name outside every expected class (negative control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, isClosed } = makeFakeQuery([
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'unexpected-leak', status: 'connected' },
        ],
      }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));
    await flush();

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('unexpected-leak');
    expect(isClosed()).toBe(true);
  });

  it('terminates with a fatal event when an mcp__-prefixed tool name reports a server outside every expected class (negative control)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__unexpected-leak__do_thing'] }),
    ]);
    new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn, enabledTools: ['Read'] }));
    await flush();

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('unexpected-leak');
  });

  it('fail-closed: a user/local-scope name is treated as unexpected (fatal) when expectedMcpServerNames.unavailable is true, even though it is present in userLocal', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'chrome-devtools', status: 'connected' },
        ],
      }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        expectedMcpServerNames: { userLocal: new Set(['chrome-devtools']), unavailable: true },
      }),
    );
    await flush();

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('chrome-devtools');
    expect(fatalEvents[0].message).toContain('~/.claude.json');
  });

  it('emits mcp-servers-discovered classifying reserved/project/user/connector scopes, BEFORE the fatal decision, and omits an unclassifiable name from the array', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'console', status: 'connected' },
          { name: 'my-server', status: 'connected' },
          { name: 'chrome-devtools', status: 'connected' },
          { name: 'claude.ai Google Drive', status: 'connected' },
          { name: 'unexpected-leak', status: 'failed' },
        ],
      }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: new Map([
          ['my-server', { hash: 'h1', config: { type: 'stdio', command: 'echo' } }],
        ]),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
        expectedMcpServerNames: { userLocal: new Set(['chrome-devtools']), unavailable: false },
      }),
    );
    await flush();

    const discovered = eventsOfType(events, 'mcp-servers-discovered');
    expect(discovered).toHaveLength(1);
    expect(discovered[0].servers).toEqual([
      { name: 'agent-console', scope: 'reserved', status: 'connected' },
      { name: 'console', scope: 'reserved', status: 'connected' },
      { name: 'my-server', scope: 'project', status: 'connected' },
      { name: 'chrome-devtools', scope: 'user', status: 'connected' },
      { name: 'claude.ai Google Drive', scope: 'connector', status: 'connected' },
    ]);
    // epic #1636 Phase 5 PR-3a (Item 3): explicit, on top of
    // `toEqual`'s already-implicit exact-shape check above -- every entry
    // form (b) (`handleSystemInit`) emits, INCLUDING the `'project'`-scope
    // one, has neither `decision` nor `hash`. This is the exact premise
    // `embedded-agent-worker-service.ts`'s `isFormA` detection relies on
    // (its own comment: "form (a) ... reports EVERY entry as `scope:
    // 'project'` with `decision` always set ... `emitMcpServersDiscovered`
    // (forms (b)/(c)) never sets `decision` on any entry") to tell form (a)
    // apart from forms (b)/(c) -- if this engine ever started attaching
    // either field here, that detection would misclassify a form (b)/(c)
    // arrival as form (a) and the server-side merge would silently corrupt
    // its `runtime.projectDiscovery` snapshot.
    for (const server of discovered[0].servers) {
      expect(server).not.toHaveProperty('decision');
      expect(server).not.toHaveProperty('hash');
    }
    // The discovered event must appear BEFORE the fatal it's paired with in
    // this same flush -- the panel must see what was seen even on a fatal.
    const discoveredIndex = events.indexOf(discovered[0]);
    const fatalIndex = events.findIndex((e) => e.type === 'fatal');
    expect(fatalIndex).toBeGreaterThan(-1);
    expect(discoveredIndex).toBeLessThan(fatalIndex);
  });

  it('accepts a live-added server name after a successful setMcpServers call, but would have been fatal before it', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, push } = makeControllableMcpQuery();
    const engine = new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: new Map([
          ['newly-allowed', { hash: 'h1', config: { type: 'stdio', command: 'echo' } }],
        ]),
      }),
    );

    engine.setMcpServers([{ name: 'newly-allowed', hash: 'h1' }]);
    await flush();
    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: true },
    ]);

    events.length = 0;
    push(
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'console', status: 'connected' },
          { name: 'newly-allowed', status: 'connected' },
        ],
      }),
    );
    await flush();
    // Positive assertion, not just "no fatal": had `newly-allowed` reached
    // the wall BEFORE the live `setMcpServers` call extended the expected
    // set, this exact name would have been the one reported unexpected (see
    // the "outside every expected class" negative control above) --
    // confirming this test actually exercises the live-extension path.
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
    expect(eventsOfType(events, 'sdk-session-id')).toHaveLength(1);
  });

  // Architect finding, 2026-09-21: `classifyMcpServerScope` must classify on
  // the CORRECT channel per name source -- `'tool'` for names extracted from
  // `message.tools`'s `mcp__<slug>__<toolname>` entries (already slugified by
  // the CLI, non-alphanumeric runs replaced with `_`), `'raw'` for
  // `message.mcp_servers[].name` (the CLI's un-mangled declared name). These
  // two pins reach the wall exclusively via the already-slugified
  // `message.tools` form, never via `message.mcp_servers`, so a raw-vs-raw
  // comparison could not accidentally satisfy them.
  //
  // Polarity, measured: with `classifyMcpServerScope`'s `'tool'`-channel
  // slugify-comparison reverted to raw (unslugified) comparison, BOTH pins
  // below fail -- 'terminates with a fatal event' where none was expected,
  // because `mcp__my_server__...`/`mcp__my_server_2__...` (slugified) never
  // raw-string-matches `'my.server'`/`'my server'` (declared). Restored
  // afterward; see the PR body for the exact revert/restore commands run.
  it('accepts a user/local-scope server declared as "my.server" when reported via the slugified mcp__my_server__ tool-name form (positive control, Architect finding 2026-09-21)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__my_server__do_thing'] }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        enabledTools: ['Read'],
        expectedMcpServerNames: { userLocal: new Set(['my.server']), unavailable: false },
      }),
    );
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  it('accepts a project-scope server declared as "my server" when reported via the slugified mcp__my_server_2__ tool-name form (positive control, Architect finding 2026-09-21)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({ tools: ['Read', 'mcp__my_server_2__do_thing'] }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        enabledTools: ['Read'],
        discoveredProjectMcpServers: new Map([
          ['my server 2', { hash: 'h1', config: { type: 'stdio', command: 'echo' } }],
        ]),
        initialAllowedProjectMcpServers: [{ name: 'my server 2', hash: 'h1' }],
      }),
    );
    await flush();
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  // CodeRabbit finding on PR #1794 (2026-09-21), fixed on top of the two
  // positive pins above: slugifying is MANY-TO-ONE, so two DISTINCT raw
  // server names can collide on one slug -- `my server` (space) and
  // `my.server` (dot) both slugify to `my_server`. Before this fix,
  // `classifyMcpServerScope` slugified BOTH channels uniformly, so a
  // completely different, unexpected server literally named `my server`
  // would be incorrectly accepted merely because a DIFFERENT,
  // legitimately-allowed `my.server` shares its slug -- the wall reported
  // "expected" for a name it had never actually approved. This pin reaches
  // the wall via `message.mcp_servers[].name` (the RAW channel), NOT via
  // `message.tools`, so it exercises exact-match comparison specifically.
  //
  // Polarity, measured: with `classifyMcpServerScope` reverted to slugifying
  // BOTH channels (the bug), this pin FAILS -- 'my server' incorrectly
  // matches the slug of the expected 'my.server' and no fatal fires. With
  // the fix (raw-channel exact match), 'my server' does not match
  // 'my.server' by exact string equality, isAccountConnector/reserved/
  // project also don't match it, and the wall correctly fatals. Restored
  // afterward; see the PR body for the exact revert/restore commands run.
  //
  // Re-verified 2026-09-21 (Architect finding, hyphen-alphabet fix on the
  // `'tool'` channel): the raw channel itself is UNCHANGED by that fix, and
  // this pin was re-run against a build that slugifies the raw channel too
  // (i.e. `matchesKnown = (known) => slugifyMcpServerName(known) ===
  // slugifyMcpServerName(name)` unconditionally, ignoring `channel`) --
  // still FAILS (0 fatal events instead of 1), confirming this measurement
  // holds after the `'tool'`-channel change, not merely before it.
  it('fatals when the raw mcp_servers name "my server" is reported but only the DISTINCT raw name "my.server" (same slug) is expected (negative control, CodeRabbit finding on #1794)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeFakeQuery([
      systemInit({
        mcpServers: [{ name: 'my server', status: 'connected' }],
      }),
    ]);
    new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        expectedMcpServerNames: { userLocal: new Set(['my.server']), unavailable: false },
      }),
    );
    await flush();

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('my server');
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
    // catalog (Task, Bash, EnterWorktree, ...) AND `mcp_servers` list
    // (`chrome-devtools`, `agent-console-dev`, the claude.ai connectors, ...)
    // -- Pin 2's live containment check and the epic #1636 Phase 5 PR-2 MCP
    // wall (this file's own "disallowed tool(s)" / "MCP server outside the
    // expected set" fatal paths, both unrelated to Finding #3) would
    // otherwise terminate the session before the turn under test even
    // completes. Only the `Read` tool the fixture's own tool_use block
    // actually calls is relevant to this test, so the fixture's system:init
    // is adjusted to match the engine's `enabledTools` below and to report
    // only the reserved pair -- this narrows containment scope only, and does
    // not touch any of the assistant/tool_use/text content this test asserts
    // on.
    for (const message of messages) {
      if (message.type === 'system' && message.subtype === 'init') {
        message.tools = ['Read'];
        message.mcp_servers = [
          { name: 'agent-console', status: 'connected' },
          { name: 'console', status: 'connected' },
        ];
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
    expect(captured.options?.settings).toEqual({
      autoCompactEnabled: true,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: false,
    });
  });

  it('composes the worker toggle into the SDK settings, OFF', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, autoCompaction: false }));
    expect(captured.options?.settings).toEqual({
      autoCompactEnabled: false,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: false,
    });
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

describe('SdkEngine — the per-user claude.ai connectors toggle', () => {
  it('composes disableClaudeAiConnectors: true into the SDK settings when deps carry true', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, disableClaudeAiConnectors: true }));
    expect(captured.options?.settings).toEqual({
      autoCompactEnabled: false,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: true,
    });
  });

  it('composes disableClaudeAiConnectors: false into the SDK settings when deps carry false', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(baseDeps({ queryFn, disableClaudeAiConnectors: false }));
    expect(captured.options?.settings).toEqual({
      autoCompactEnabled: false,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: false,
    });
  });

  // Reach measurement (test-trigger.md "A check's existence is not its
  // detection power"): both tests above were confirmed to fail against a
  // `buildOptions()` with the `disableClaudeAiConnectors` field temporarily
  // removed from the `settings` object literal -- restored immediately
  // after, `git diff --stat` clean.
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

  // The `@agent-console/embedded-agent` package has no dependency on
  // `@agent-console/server` (checked: packages/embedded-agent/package.json's
  // `dependencies` list, and no other test in this file imports across that
  // boundary), so this array is a literal mirror of
  // `claudeSdkAgent.enabledTools` in
  // packages/server/src/services/embedded-agents/claude-sdk-builtin.ts
  // (epic 1636 Phase 2 opt-in), not an import of it.
  //
  // Mutation measurement: temporarily removed 'TodoWrite' from this array ->
  // the `mcp__console__TodoWrite` assertion below failed as expected (the
  // `Write`/`Edit`/mcpServers assertions were unaffected by that specific
  // mutation, confirming this test isolates the TodoWrite-registration
  // dependency it targets). Reverted after observing the failure.
  it('registers Write, Edit, and the namespaced TodoWrite tool for the claude-sdk builtin\'s enabledTools array (epic 1636 Phase 2)', () => {
    const { queryFn, captured } = makeFakeQuery([]);
    new SdkEngine(
      baseDeps({ queryFn, enabledTools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Write', 'Edit'] })
    );

    expect(captured.options?.tools).toContain('Write');
    expect(captured.options?.tools).toContain('Edit');
    expect(captured.options?.tools).toContain('mcp__console__TodoWrite');
    expect(captured.options?.mcpServers?.['console']).toBeDefined();
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
   * describes need), optionally making one of them reject.
   *
   * `holdFirstSetModel` is the ordering tests' lever: the FIRST `setModel`
   * hangs until `releaseFirstSetModel()` is called, which is the only way to
   * construct the interleaving the chain exists to prevent (a delayed first
   * call whose second half lands after a later call's). */
  function makeLiveWriteQuery(
    opts: {
      failOn?: 'setModel' | 'applyFlagSettings';
      /** Fail `applyFlagSettings` for ONE effort value only, which is what
       * makes two `model-params-applied` events tell each other apart: the
       * event carries nothing but `applied`, so two successful calls emit
       * two identical objects and their ORDER is unobservable. */
      failFlagForEffort?: string;
      holdFirstSetModel?: boolean;
      liveModel?: { value: string | undefined };
    } = {},
  ): LiveWriteHandle & { releaseFirstSetModel: () => void } {
    const setModelCalls: (string | undefined)[] = [];
    const flagSettings: Record<string, unknown>[] = [];
    let release: () => void = () => {};
    const held =
      opts.holdFirstSetModel === true
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : null;
    let setModelSeen = 0;
    const { queryFn: base } = makeFakeQuery([]);
    const queryFn: QueryFn = (params) =>
      asQuery(
        Object.assign(base(params), {
          setModel: async (model?: string) => {
            setModelCalls.push(model);
            setModelSeen += 1;
            if (held !== null && setModelSeen === 1) await held;
            // The LIVE session's model, written when the call completes --
            // the state an interleaving would leave on the wrong value.
            if (opts.liveModel) opts.liveModel.value = model;
            if (opts.failOn === 'setModel') throw new Error('transport gone');
          },
          applyFlagSettings: async (settings: Record<string, unknown>) => {
            flagSettings.push(settings);
            if (opts.failOn === 'applyFlagSettings') throw new Error('transport gone');
            if (
              opts.failFlagForEffort !== undefined &&
              settings.effortLevel === opts.failFlagForEffort
            ) {
              throw new Error('transport gone');
            }
          },
        }),
      );
    return { queryFn, setModelCalls, flagSettings, releaseFirstSetModel: () => release() };
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

  /**
   * The serialization property. A call's work is two AWAITED live writes, so
   * two detached calls can interleave as A.setModel, B.setModel,
   * B.applyFlagSettings, A.applyFlagSettings -- leaving the live session
   * holding A's values while the stream already reported on B.
   *
   * Two fixture choices carry the whole test:
   * - The fake's FIRST `setModel` hangs until released, which is what makes
   *   the interleaving REACHABLE. With an unheld fake both calls happen to
   *   complete in arrival order and the two shapes are indistinguishable.
   * - The FIRST call's effort write fails (`failFlagForEffort: 'low'`), so
   *   the two `model-params-applied` events differ. The event carries
   *   nothing but `applied`, so two successful calls emit two identical
   *   objects and their order cannot be read at all -- the assertion would
   *   be vacuous.
   *
   * Measured reach (chain reverted to a detached
   * `void this.applyModelParamsOnce(params)`, this test re-run):
   * - the mid-test assertion fails first: the second call's event has
   *   already arrived while the first is still held inside `setModel`.
   * - with that assertion removed to see the rest, (1) fails --
   *   `liveModel.value` is `'model-A'`, the earlier call landing LAST, which
   *   is the defect itself.
   * - with (1) also removed, (2) fails -- the events arrive
   *   `[applied: true, applied: false]`, i.e. the second call reporting
   *   before the first.
   * Both halves are kept: (1) alone would pass under a race that got lucky,
   * and (2) is what proves the serialization rather than the outcome.
   */
  it('applies two rapid changes in call order, never letting the earlier one land last', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const liveModel: { value: string | undefined } = { value: undefined };
    const { queryFn, releaseFirstSetModel } = makeLiveWriteQuery({
      holdFirstSetModel: true,
      failFlagForEffort: 'low',
      liveModel,
    });
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    engine.setModelParams({ model: 'model-A', reasoningEffort: 'low', contextWindowTokens: null });
    engine.setModelParams({ model: 'model-B', reasoningEffort: 'high', contextWindowTokens: null });
    await flush();
    // Nothing has landed yet: the second call cannot start until the first
    // has SETTLED, and the first is held inside `setModel`.
    expect(eventsOfType(events, 'model-params-applied')).toEqual([]);
    expect(liveModel.value).toBeUndefined();

    releaseFirstSetModel();
    await flush();

    // (1) The live session ends on the SECOND call's model.
    expect(liveModel.value).toBe('model-B');
    // (2) ...and the two reports arrive in CALL order -- the first call's
    // failed apply first, then the second call's successful one.
    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: false },
      { v: 1, type: 'model-params-applied', applied: true },
    ]);
  });

  /**
   * The chain's own failure mode, which the ordering test above cannot
   * reach: a link that REJECTS leaves `modelParamsChain` rejected, and every
   * link appended afterwards is then skipped WITHOUT its body running --
   * silently dropping every later parameter change for the life of the
   * engine. That is what the trailing `.catch(() => {})` is for.
   *
   * The rejection has to come from OUTSIDE the live writes to exist at all:
   * `applyModelParamsOnce` catches its own `setModel`/`applyFlagSettings`
   * failures and reports them as `applied: false`. Here the first call's
   * `emit` consumer throws -- from the catch branch's `applied: false`
   * emit, which is not itself wrapped -- which is exactly the shape that
   * escapes.
   *
   * Measured reach (dropping the `.catch(() => {})` from the chain):
   * - FAILS immediately on the escaped `emit consumer blew up` rejection,
   *   which bun attributes to this test -- the rejected chain has nothing
   *   left to handle it.
   * - with that rejection silenced but the chain still left poisoned (a
   *   `void this.modelParamsChain.catch(() => {})` AFTER the assignment, so
   *   the field keeps holding the rejected promise), FAILS on the length:
   *   1 event, not 2. The second call's body never ran.
   */
  it('a failed link does not poison the chain: the next call still applies', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeLiveWriteQuery({ failOn: 'applyFlagSettings' });
    let throwOnNextEmit = true;
    const engine = new SdkEngine(
      baseDeps({
        queryFn,
        emit: (e) => {
          events.push(e);
          if (e.type === 'model-params-applied' && throwOnNextEmit) {
            throwOnNextEmit = false;
            throw new Error('emit consumer blew up');
          }
        },
      }),
    );

    engine.setModelParams({ model: 'model-A', reasoningEffort: 'low', contextWindowTokens: null });
    await flush();
    expect(eventsOfType(events, 'model-params-applied')).toEqual([
      { v: 1, type: 'model-params-applied', applied: false },
    ]);

    // The second call's event is the proof its body ran at all.
    engine.setModelParams({ model: 'model-B', reasoningEffort: 'high', contextWindowTokens: null });
    await flush();
    expect(eventsOfType(events, 'model-params-applied')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// epic #1636 Phase 5 PR-2: setMcpServers
// ---------------------------------------------------------------------------

describe('SdkEngine — setMcpServers (epic #1636 Phase 5 PR-2, Architect ruling B: (name, hash) pairs only)', () => {
  interface LiveMcpWriteHandle {
    queryFn: QueryFn;
    setMcpServersCalls: Array<Record<string, unknown>>;
    statusCallCount: () => number;
  }

  /** Mirrors `makeLiveWriteQuery` (setModelParams describe block) but for
   * `setMcpServers`/`mcpServerStatus` -- the two live-write methods THIS
   * describe block's tests call. `holdFirst` is the ordering tests' lever,
   * same shape as `makeLiveWriteQuery`'s `holdFirstSetModel`. This fake
   * mocks the SDK's OWN `Query.setMcpServers`, which still takes a
   * `Record<string, McpServerConfig>` -- only `SdkEngine.setMcpServers`'s
   * OWN parameter shape (Architect ruling B) changed to (name, hash) pairs;
   * this fake's argument shape is unaffected. */
  function makeLiveMcpWriteQuery(
    opts: {
      holdFirst?: boolean;
      failOn?: 'setMcpServers';
      errorsFor?: string;
      /** What the fake's `mcpServerStatus()` resolves to; defaults to `[]`. */
      statusResult?: Array<{ name: string; status: string }>;
    } = {},
  ): LiveMcpWriteHandle & { releaseFirst: () => void } {
    const setMcpServersCalls: Array<Record<string, unknown>> = [];
    let statusCalls = 0;
    let release: () => void = () => {};
    const held =
      opts.holdFirst === true
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : null;
    let seen = 0;
    const { queryFn: base } = makeFakeQuery([]);
    const queryFn: QueryFn = (params) =>
      asQuery(
        Object.assign(base(params), {
          setMcpServers: async (servers: Record<string, unknown>) => {
            setMcpServersCalls.push(servers);
            seen += 1;
            if (held !== null && seen === 1) await held;
            if (opts.failOn === 'setMcpServers') throw new Error('transport gone');
            const errors =
              opts.errorsFor !== undefined && servers[opts.errorsFor] !== undefined
                ? { [opts.errorsFor]: 'connection refused' }
                : {};
            return { added: Object.keys(servers), removed: [], errors };
          },
          mcpServerStatus: async () => {
            statusCalls += 1;
            return opts.statusResult ?? [];
          },
        }),
      );
    return {
      queryFn,
      setMcpServersCalls,
      statusCallCount: () => statusCalls,
      releaseFirst: () => release(),
    };
  }

  /** Shorthand: a `discoveredProjectMcpServers` map with one entry per
   * `[name, hash]` pair, all sharing the same trivial stdio config -- the
   * config's content is never the subject of these tests, only whether
   * resolution succeeds. */
  function discoveryMap(...pairs: Array<[string, string]>): Map<string, { hash: string; config: McpServerConfig }> {
    return new Map(pairs.map(([name, hash]) => [name, { hash, config: { type: 'stdio', command: name } }]));
  }

  it('resolves a pair against discovery and sends the reserved pair plus the resolved config, never a partial set', async () => {
    const { queryFn, setMcpServersCalls } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(
      baseDeps({ queryFn, discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    expect(setMcpServersCalls).toHaveLength(1);
    expect(Object.keys(setMcpServersCalls[0]).sort()).toEqual(['agent-console', 'console', 'my-server']);
  });

  it('reuses the SAME reserved agent-console config and console server instance across buildOptions and a live setMcpServers call (premise P-a)', async () => {
    let capturedCall: Record<string, unknown> | undefined;
    const captured: { options?: Options } = {};
    const queryFn: QueryFn = (params) => {
      captured.options = params.options;
      const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
        await new Promise<never>(() => {});
      })();
      return asQuery(
        Object.assign(gen, {
          interrupt: async () => undefined,
          close: () => {},
          getContextUsage: async () => usableContextUsage(1000),
          setMcpServers: async (servers: Record<string, unknown>) => {
            capturedCall = servers;
            return { added: [], removed: [], errors: {} };
          },
          mcpServerStatus: async () => [],
        }),
      );
    };
    const engine = new SdkEngine(baseDeps({ queryFn }));

    engine.setMcpServers([]);
    await flush();

    expect(capturedCall?.['agent-console']).toBe(captured.options?.mcpServers?.['agent-console']);
    expect(capturedCall?.['console']).toBe(
      captured.options?.mcpServers?.['console'],
    );
  });

  it('reports applied: true with no errors key when the live call succeeds cleanly', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(
      baseDeps({ queryFn, emit: (e) => events.push(e), discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    const applied = eventsOfType(events, 'mcp-servers-applied');
    expect(applied).toEqual([{ v: 1, type: 'mcp-servers-applied', applied: true }]);
    expect('errors' in applied[0]).toBe(false);
  });

  it('forwards a per-server errors map from McpSetServersResult while still reporting applied: true', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeLiveMcpWriteQuery({ errorsFor: 'my-server' });
    const engine = new SdkEngine(
      baseDeps({ queryFn, emit: (e) => events.push(e), discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: true, errors: { 'my-server': 'connection refused' } },
    ]);
  });

  it('reports applied: false with an errors map when the live call throws', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn } = makeLiveMcpWriteQuery({ failOn: 'setMcpServers' });
    const engine = new SdkEngine(
      baseDeps({ queryFn, emit: (e) => events.push(e), discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    expect(() => engine.setMcpServers([{ name: 'my-server', hash: 'h1' }])).not.toThrow();
    await flush();

    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: false, errors: { '*': 'transport gone' } },
    ]);
  });

  it('reports applied: false, reason: restart-required and never touches the SDK once the engine is dead', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, setMcpServersCalls } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(
      baseDeps({ queryFn, emit: (e) => events.push(e), discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );
    engine.dispose();

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    expect(setMcpServersCalls).toEqual([]);
    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: false, reason: 'restart-required' },
    ]);
  });

  it('emits an mcp-servers-discovered event (form c) from a fresh mcpServerStatus() read after a successful apply', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, statusCallCount } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(
      baseDeps({
        queryFn,
        emit: (e) => events.push(e),
        discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
      }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    expect(statusCallCount()).toBe(1);
    // The fake's mcpServerStatus() resolves to []; the discovered event still
    // fires (with an empty servers array), proving the call site is reached
    // unconditionally after a successful apply.
    expect(eventsOfType(events, 'mcp-servers-discovered')).toEqual([
      { v: 1, type: 'mcp-servers-discovered', servers: [] },
    ]);
  });

  it('form (c) entries carry neither `decision` nor `hash`, even for a `project`-scope name (Item 3)', async () => {
    // epic #1636 Phase 5 PR-3a: the sibling test above proves the empty-array
    // shape; this one populates `mcpServerStatus()`'s reading so there is an
    // actual `'project'`-scope entry to assert on -- the case
    // `embedded-agent-worker-service.ts`'s `isFormA` detection most needs to
    // be robust against, since a `'project'`-scope entry is exactly what
    // form (a) itself always is.
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, statusCallCount } = makeLiveMcpWriteQuery({
      statusResult: [
        { name: 'agent-console', status: 'connected' },
        { name: 'my-server', status: 'connected' },
      ],
    });
    const engine = new SdkEngine(
      baseDeps({
        queryFn,
        emit: (e) => events.push(e),
        discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']),
        initialAllowedProjectMcpServers: [{ name: 'my-server', hash: 'h1' }],
      }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    expect(statusCallCount()).toBe(1);
    const discovered = eventsOfType(events, 'mcp-servers-discovered');
    expect(discovered).toHaveLength(1);
    expect(discovered[0].servers).toEqual([
      { name: 'agent-console', scope: 'reserved', status: 'connected' },
      { name: 'my-server', scope: 'project', status: 'connected' },
    ]);
    // Explicit, on top of `toEqual`'s already-implicit exact-shape check
    // above -- see the form (b) test's identical comment for why this
    // matters to `isFormA`'s detection.
    for (const server of discovered[0].servers) {
      expect(server).not.toHaveProperty('decision');
      expect(server).not.toHaveProperty('hash');
    }
  });

  it('does not call mcpServerStatus() when the live call throws', async () => {
    const { queryFn, statusCallCount } = makeLiveMcpWriteQuery({ failOn: 'setMcpServers' });
    const engine = new SdkEngine(
      baseDeps({ queryFn, discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();

    expect(statusCallCount()).toBe(0);
  });

  it('applies two rapid setMcpServers calls in call order (lock ordering)', async () => {
    const { queryFn, setMcpServersCalls, releaseFirst } = makeLiveMcpWriteQuery({ holdFirst: true });
    const engine = new SdkEngine(
      baseDeps({ queryFn, discoveredProjectMcpServers: discoveryMap(['a', 'ha'], ['b', 'hb']) }),
    );

    engine.setMcpServers([{ name: 'a', hash: 'ha' }]);
    engine.setMcpServers([{ name: 'b', hash: 'hb' }]);
    await flush();
    // The second call cannot start until the first has SETTLED, and the
    // first is held.
    expect(setMcpServersCalls).toHaveLength(1);

    releaseFirst();
    await flush();
    const nonReservedKeys = setMcpServersCalls.map((call) =>
      Object.keys(call).filter((k) => k !== 'agent-console' && k !== 'console'),
    );
    expect(nonReservedKeys).toEqual([['a'], ['b']]);
  });

  it('reuses the SAME liveWritesChain as setModelParams: a live MCP-server add never interleaves with a model/effort change', async () => {
    const callOrder: string[] = [];
    let releaseSetModel: () => void = () => {};
    const holdSetModel = new Promise<void>((resolve) => {
      releaseSetModel = resolve;
    });
    const { queryFn: base } = makeFakeQuery([]);
    const queryFn: QueryFn = (params) =>
      asQuery(
        Object.assign(base(params), {
          setModel: async () => {
            callOrder.push('setModel:start');
            await holdSetModel;
            callOrder.push('setModel:end');
          },
          applyFlagSettings: async () => {
            callOrder.push('applyFlagSettings');
          },
          setMcpServers: async (servers: Record<string, unknown>) => {
            callOrder.push('setMcpServers:start');
            callOrder.push('setMcpServers:end');
            return { added: Object.keys(servers), removed: [], errors: {} };
          },
          mcpServerStatus: async () => [],
        }),
      );
    const engine = new SdkEngine(
      baseDeps({ queryFn, discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    engine.setModelParams({ model: 'model-A', reasoningEffort: 'low', contextWindowTokens: null });
    engine.setMcpServers([{ name: 'my-server', hash: 'h1' }]);
    await flush();
    // Nothing from setMcpServers has started yet -- it is chained behind the
    // still-held setModelParams call, proving the two share ONE lock rather
    // than running on independent chains.
    expect(callOrder).toEqual(['setModel:start']);

    releaseSetModel();
    await flush();
    expect(callOrder).toEqual([
      'setModel:start',
      'setModel:end',
      'applyFlagSettings',
      'setMcpServers:start',
      'setMcpServers:end',
    ]);
  });

  // -------------------------------------------------------------------------
  // Resolution: (name, hash) pairs resolved against discoveredProjectMcpServers
  // -------------------------------------------------------------------------

  it('reports not-discovered for a pair naming a server absent from discoveredProjectMcpServers, and still calls the SDK with ONLY the reserved pair', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, setMcpServersCalls } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(baseDeps({ queryFn, emit: (e) => events.push(e) }));

    engine.setMcpServers([{ name: 'unknown', hash: 'h1' }]);
    await flush();

    expect(setMcpServersCalls).toHaveLength(1);
    expect(Object.keys(setMcpServersCalls[0]).sort()).toEqual(['agent-console', 'console']);
    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: true, errors: { unknown: 'not-discovered' } },
    ]);
  });

  it('reports hash-mismatch for a pair whose hash no longer matches the discovered entry (the branch-swap case)', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, setMcpServersCalls } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(
      baseDeps({ queryFn, emit: (e) => events.push(e), discoveredProjectMcpServers: discoveryMap(['my-server', 'CURRENT']) }),
    );

    engine.setMcpServers([{ name: 'my-server', hash: 'STALE' }]);
    await flush();

    expect(Object.keys(setMcpServersCalls[0]).sort()).toEqual(['agent-console', 'console']);
    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: true, errors: { 'my-server': 'hash-mismatch' } },
    ]);
  });

  it('applies a mix of resolvable and unresolvable pairs in one call: the resolvable one is started, the other is reported and never touches the SDK call', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, setMcpServersCalls } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(
      baseDeps({ queryFn, emit: (e) => events.push(e), discoveredProjectMcpServers: discoveryMap(['my-server', 'h1']) }),
    );

    engine.setMcpServers([
      { name: 'my-server', hash: 'h1' },
      { name: 'other', hash: 'hX' },
    ]);
    await flush();

    expect(Object.keys(setMcpServersCalls[0]).sort()).toEqual(['agent-console', 'console', 'my-server']);
    expect(eventsOfType(events, 'mcp-servers-applied')).toEqual([
      { v: 1, type: 'mcp-servers-applied', applied: true, errors: { other: 'not-discovered' } },
    ]);
  });

  it('the reserved pair is present in EVERY SDK call, including one whose pairs all fail resolution', async () => {
    const { queryFn, setMcpServersCalls } = makeLiveMcpWriteQuery();
    const engine = new SdkEngine(baseDeps({ queryFn }));

    engine.setMcpServers([{ name: 'unknown-a', hash: 'h1' }]);
    await flush();
    engine.setMcpServers([{ name: 'unknown-b', hash: 'h2' }]);
    await flush();

    expect(setMcpServersCalls).toHaveLength(2);
    for (const call of setMcpServersCalls) {
      expect(Object.keys(call).sort()).toEqual(['agent-console', 'console']);
    }
  });

  it('does NOT extend the live-added expected-name set for a pair that failed resolution', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, push } = makeControllableMcpQuery();
    const engine = new SdkEngine(baseDeps({ emit: (e) => events.push(e), queryFn }));

    // No discovery seeded -- this pair can never resolve.
    engine.setMcpServers([{ name: 'still-unexpected', hash: 'h1' }]);
    await flush();

    push(
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'still-unexpected', status: 'connected' },
        ],
      }),
    );
    await flush();

    // Unlike a resolved live add, a failed-resolution pair must still trip
    // the containment wall if it somehow shows up in system:init.
    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('still-unexpected');
  });

  // -------------------------------------------------------------------------
  // Revocation (CodeRabbit finding, PR #1794): setMcpServers is a full-state
  // replace, so a name omitted from a LATER successful call must stop
  // reading as 'project' scope -- liveAddedMcpServerNames is not add-only.
  // -------------------------------------------------------------------------

  it('revokes a name omitted from a later successful setMcpServers call: it no longer counts as project scope and trips the wall', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, push } = makeControllableMcpQuery();
    const engine = new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: discoveryMap(['keep', 'hk'], ['revoke', 'hr']),
      }),
    );

    // First call live-adds BOTH names.
    engine.setMcpServers([
      { name: 'keep', hash: 'hk' },
      { name: 'revoke', hash: 'hr' },
    ]);
    await flush();

    // Second call is the FULL new allowed set -- 'revoke' is omitted, which
    // per the SDK's full-state-replace contract means the SDK itself no
    // longer has it live.
    engine.setMcpServers([{ name: 'keep', hash: 'hk' }]);
    await flush();

    push(
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'revoke', status: 'connected' },
        ],
      }),
    );
    await flush();

    // Had the fix not shipped, 'revoke' would still read as 'project' scope
    // (still in the add-only set) and this would NOT be fatal.
    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('revoke');
  });

  it('a THROWING setMcpServers call restores the pre-call live-added set: a name added by an earlier successful call is unaffected', async () => {
    const events: EmbeddedAgentEvent[] = [];
    // Call #1 succeeds (adds 'keep'); call #2 throws while attempting to
    // omit it -- the pre-call snapshot restore must keep 'keep' live-added,
    // since the throwing call never took effect.
    const { queryFn, push } = makeControllableMcpQuery({ failOnCallNumber: 2 });
    const engine = new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: discoveryMap(['keep', 'hk']),
      }),
    );

    engine.setMcpServers([{ name: 'keep', hash: 'hk' }]);
    await flush();

    engine.setMcpServers([]);
    await flush();
    expect(eventsOfType(events, 'mcp-servers-applied').at(-1)).toEqual({
      v: 1,
      type: 'mcp-servers-applied',
      applied: false,
      errors: { '*': 'transport gone' },
    });

    events.length = 0;
    push(
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'keep', status: 'connected' },
        ],
      }),
    );
    await flush();

    // The throwing second call must not have dropped 'keep' from the live-
    // added set -- it is still accepted, not fatal.
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Unified name-membership set (Architect ruling, 2026-09-21, PR #1794
  // follow-up): the two revocation/throw-restore pins above cover a name
  // added via a LIVE `setMcpServers` call. `classifyMcpServerScope`'s
  // `'project'` branch ALSO unconditionally checked
  // `Object.keys(this.initialProjectMcpServers)` -- the activation-time
  // allowed set -- which had the SAME "stale membership survives a later
  // full-state-replace" hole for a name allowed at CONSTRUCTION, never
  // closed by the live-added fix. `currentProjectMcpServerNames` collapses
  // both origins (activation-time allow, and anything added/revoked live)
  // into ONE mutable set, so there is now exactly one place this invariant
  // can ever be wrong. These two pins are the initial-set analogue of the
  // two above.
  //
  // Polarity, measured: with `classifyMcpServerScope`'s `'project'` branch
  // reverted to ALSO checking `Object.keys(this.initialProjectMcpServers)`
  // unconditionally (i.e. `|| Object.keys(this.initialProjectMcpServers).some(matchesKnown)`
  // added back before the unified-set check), the first pin below (empty-
  // pairs-call revokes 'A') FAILS on BOTH channels -- 'A' still matches the
  // initial map's key directly and no fatal fires, even though the SDK no
  // longer has it live. Restored afterward; the second pin (throw restores
  // 'A') is unaffected either way, since restoring the unified set already
  // keeps 'A' live-classified through the SAME branch.
  // -------------------------------------------------------------------------

  it('revokes an ACTIVATION-time (initial) server name when a later successful setMcpServers call with an EMPTY pairs array omits it -- reported via BOTH the raw and tool channel', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, push } = makeControllableMcpQuery();
    const engine = new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: discoveryMap(['A', 'hA']),
        initialAllowedProjectMcpServers: [{ name: 'A', hash: 'hA' }],
      }),
    );

    // A full-state-replace call resolving to nothing NEW still succeeds --
    // the reserved pair is always sent (premise P-a) -- and per the SDK's
    // own full-state-replace contract, 'A' (omitted here) is no longer live
    // even though it was allowed at ACTIVATION, not via a prior live call.
    engine.setMcpServers([]);
    await flush();

    // RAW channel: system:init reports 'A' again in mcp_servers[].
    push(
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'A', status: 'connected' },
        ],
      }),
    );
    await flush();

    // Had the fix not shipped (the initial map checked unconditionally),
    // 'A' would still read as 'project' scope and this would NOT be fatal.
    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('A');
  });

  it('revokes an ACTIVATION-time (initial) server name via the TOOL channel too, after a later successful setMcpServers call with an EMPTY pairs array omits it', async () => {
    const events: EmbeddedAgentEvent[] = [];
    const { queryFn, push } = makeControllableMcpQuery();
    const engine = new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: discoveryMap(['A', 'hA']),
        initialAllowedProjectMcpServers: [{ name: 'A', hash: 'hA' }],
      }),
    );

    engine.setMcpServers([]);
    await flush();

    // TOOL channel: system:init reports a tool namespaced under 'A' again --
    // `mcpServerOf('mcp__A__something') === 'A'`, no slugify ambiguity since
    // 'A' has no non-alphanumeric characters.
    push(systemInit({ tools: ['Read', 'mcp__A__something'] }));
    await flush();

    const fatalEvents = eventsOfType(events, 'fatal');
    expect(fatalEvents).toHaveLength(1);
    expect(fatalEvents[0].message).toContain('A');
  });

  it('a THROWING setMcpServers call restores the pre-call set for an ACTIVATION-time (initial) server too: it is still accepted afterward, not fatal', async () => {
    const events: EmbeddedAgentEvent[] = [];
    // The one and only setMcpServers call throws -- its outcome on the SDK's
    // actual live state is UNKNOWN, so the conservative/safe choice is to
    // restore (keep) 'A' live-classified, exactly as the pre-existing
    // throw-restore pin above does for a live-added name. Optimistically
    // dropping 'A' here would false-fatal a server that may still be live;
    // optimistically keeping the (empty) attempted state would be no
    // different in this case, which is why the restore-to-last-known
    // behavior -- not either optimistic alternative -- is the one under
    // test.
    const { queryFn, push } = makeControllableMcpQuery({ failOnCallNumber: 1 });
    const engine = new SdkEngine(
      baseDeps({
        emit: (e) => events.push(e),
        queryFn,
        discoveredProjectMcpServers: discoveryMap(['A', 'hA']),
        initialAllowedProjectMcpServers: [{ name: 'A', hash: 'hA' }],
      }),
    );

    engine.setMcpServers([]);
    await flush();
    expect(eventsOfType(events, 'mcp-servers-applied').at(-1)).toEqual({
      v: 1,
      type: 'mcp-servers-applied',
      applied: false,
      errors: { '*': 'transport gone' },
    });

    events.length = 0;
    push(
      systemInit({
        mcpServers: [
          { name: 'agent-console', status: 'connected' },
          { name: 'A', status: 'connected' },
        ],
      }),
    );
    await flush();

    // The throwing call must not have dropped 'A' from the initial
    // activation-time set -- it is still accepted, not fatal.
    expect(eventsOfType(events, 'fatal')).toHaveLength(0);
  });
});
