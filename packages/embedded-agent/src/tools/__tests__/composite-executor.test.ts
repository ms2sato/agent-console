import { describe, it, expect, mock } from 'bun:test';
import type { ToolExecutor, ToolCallOutcome } from '../../mcp.js';
import type { ToolDefinition } from '../../providers/types.js';
import { RuleActivator, type ActivationBlock, type RuleActivatorLike } from '../../rule-activation.js';
import type { ScopedRule } from '../../system-prompt.js';
import { CompositeToolExecutor } from '../composite-executor.js';
import type { BuiltinTool, BuiltinToolContext } from '../index.js';

function makeMcpStub(tools: ToolDefinition[], callToolFn?: ToolExecutor['callTool']): ToolExecutor {
  return {
    listTools: async () => tools,
    callTool: callToolFn ?? (async () => ({ ok: true, result: 'mcp-result' })),
  };
}

/** Default double: never matches, never activates -- most tests in this file
 * are not about rule activation at all, so they use this to keep the
 * appendix-composition logic exercised by the dedicated describe block below
 * out of their assertions. */
function makeNoopRuleActivator(): RuleActivatorLike {
  return {
    matchScopedRules: () => [],
    activate: async () => null,
  };
}

function makeBuiltinTool(
  name: string,
  overrides: Partial<Pick<ToolDefinition, 'description' | 'parameters'>> = {},
): BuiltinTool & { executeMock: ReturnType<typeof mock> } {
  const executeMock = mock(async () => ({ ok: true, result: `${name}-result` }));
  return {
    name: name as BuiltinTool['name'],
    definition: {
      name,
      description: overrides.description ?? `${name} builtin tool`,
      parameters: overrides.parameters ?? { type: 'object', properties: {} },
    },
    execute: executeMock,
    executeMock,
  };
}

describe('CompositeToolExecutor', () => {
  it('merges builtin and MCP tools, builtin first', async () => {
    const mcp = makeMcpStub([{ name: 'close_session', description: 'closes', parameters: {} }]);
    const readTool = makeBuiltinTool('Read');
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator: makeNoopRuleActivator(),
    });

    const tools = await composite.listTools();
    expect(tools).toEqual([readTool.definition, { name: 'close_session', description: 'closes', parameters: {} }]);
  });

  it('resolves a name collision in favor of the builtin, and fires onNameCollision exactly once', async () => {
    const mcpReadDefinition: ToolDefinition = {
      name: 'Read',
      description: 'mcp-authored Read',
      parameters: { type: 'object', properties: { foo: { type: 'string' } } },
    };
    const mcp = makeMcpStub([mcpReadDefinition]);
    const builtinRead = makeBuiltinTool('Read', { description: 'builtin Read' });
    const onNameCollision = mock(() => {});
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [builtinRead],
      ctx: { locationPath: '/work' },
      ruleActivator: makeNoopRuleActivator(),
      onNameCollision,
    });

    const tools = await composite.listTools();

    const readEntries = tools.filter((t) => t.name === 'Read');
    expect(readEntries).toHaveLength(1);
    expect(readEntries[0].description).toBe('builtin Read');
    expect(readEntries[0].parameters).toEqual(builtinRead.definition.parameters);
    expect(onNameCollision).toHaveBeenCalledTimes(1);
    expect(onNameCollision).toHaveBeenCalledWith('Read');
  });

  it('dispatches a builtin name to the builtin, not the MCP executor', async () => {
    const mcpCallTool = mock(async (): Promise<ToolCallOutcome> => ({ ok: true, result: 'mcp' }));
    const mcp = makeMcpStub([], mcpCallTool);
    const readTool = makeBuiltinTool('Read');
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator: makeNoopRuleActivator(),
    });

    const signal = new AbortController().signal;
    const result = await composite.callTool('Read', { path: 'x' }, signal);

    expect(result).toEqual({ ok: true, result: 'Read-result' });
    expect(readTool.executeMock).toHaveBeenCalledTimes(1);
    expect(mcpCallTool).not.toHaveBeenCalled();
  });

  it('dispatches a non-builtin name to the MCP executor, not any builtin', async () => {
    const mcpCallTool = mock(async (): Promise<ToolCallOutcome> => ({ ok: true, result: 'mcp' }));
    const mcp = makeMcpStub([], mcpCallTool);
    const readTool = makeBuiltinTool('Read');
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator: makeNoopRuleActivator(),
    });

    const signal = new AbortController().signal;
    const result = await composite.callTool('close_session', {}, signal);

    expect(result).toEqual({ ok: true, result: 'mcp' });
    expect(mcpCallTool).toHaveBeenCalledTimes(1);
    expect(readTool.executeMock).not.toHaveBeenCalled();
  });

  it('passes the exact ctx (no additional fields) to a builtin tool — secret non-leakage regression guard', async () => {
    // The ctx type has no apiKey/token field at all, so this is structurally
    // enforced (design-principles.md "enforce constraints through structure").
    // This runtime assertion is the regression guard: if a future change ever
    // threads more context into BuiltinToolContext, this exact-equality
    // assertion forces an explicit, reviewed decision about what's safe to
    // expose, rather than silently widening what a builtin tool can observe.
    const fakeTool = makeBuiltinTool('FakeTool');
    const mcp = makeMcpStub([]);
    const ctx: BuiltinToolContext = { locationPath: '/some/path' };
    const composite = new CompositeToolExecutor({ mcp, builtins: [fakeTool], ctx, ruleActivator: makeNoopRuleActivator() });

    await composite.callTool('FakeTool', {}, new AbortController().signal);

    expect(fakeTool.executeMock).toHaveBeenCalledTimes(1);
    const receivedCtx = fakeTool.executeMock.mock.calls[0][1];
    expect(receivedCtx).toEqual({ locationPath: '/some/path' });
  });

  it('forwards the exact signal object passed into callTool() as the third arg to builtin.execute()', async () => {
    const readTool = makeBuiltinTool('Read');
    const mcp = makeMcpStub([]);
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator: makeNoopRuleActivator(),
    });

    const signal = new AbortController().signal;
    await composite.callTool('Read', { path: 'x' }, signal);

    expect(readTool.executeMock).toHaveBeenCalledTimes(1);
    const receivedSignal = readTool.executeMock.mock.calls[0][2];
    expect(receivedSignal).toBe(signal);
  });

  it('converts a builtin tool execute() rejection into a resolved {ok:false} outcome instead of throwing', async () => {
    // Regression guard for the never-throws ToolExecutor contract (see mcp.ts
    // McpToolClient.callTool's own try/catch). AgentLoop.runTurn calls
    // executor.callTool() with no surrounding try/catch of its own, trusting
    // that contract; a builtin path that throws (e.g. resolveConfinedPath's
    // fsPromises.realpath rejecting on ENOENT/EACCES) must not propagate.
    const throwingTool = makeBuiltinTool('Read');
    throwingTool.execute = mock(async () => {
      throw new Error('locationPath vanished (ENOENT)');
    });
    const mcpCallTool = mock(async (): Promise<ToolCallOutcome> => ({ ok: true, result: 'mcp' }));
    const mcp = makeMcpStub([], mcpCallTool);
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [throwingTool],
      ctx: { locationPath: '/work' },
      ruleActivator: makeNoopRuleActivator(),
    });

    const signal = new AbortController().signal;
    let result: ToolCallOutcome;
    try {
      result = await composite.callTool('Read', {}, signal);
    } catch {
      throw new Error(
        'composite.callTool() must not throw for a builtin execute() rejection; it must resolve with {ok:false}',
      );
    }

    expect(result).toEqual({ ok: false, result: 'locationPath vanished (ENOENT)' });
    expect(mcpCallTool).not.toHaveBeenCalled();
  });
});

describe('CompositeToolExecutor — Phase B (#1343 R2) scoped-rule activation appendix', () => {
  const activationBlock: ActivationBlock = {
    text: '[rule activated: r1]\n--- Rule (applies to: **/*): /rules/r1.md ---\nCONTENT',
    skippedForSize: [],
    activatedNames: ['r1'],
  };

  it('sets outcome.appendix when a builtin call matches a scoped rule', async () => {
    const mcp = makeMcpStub([]);
    const readTool = makeBuiltinTool('Read');
    const ruleActivator: RuleActivatorLike = {
      matchScopedRules: (name, args) =>
        name === 'Read' && (args as { path?: unknown })?.path === 'match.ts' ? ['r1'] : [],
      activate: async (names) => (names.includes('r1') ? activationBlock : null),
    };
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator,
    });

    const result = await composite.callTool('Read', { path: 'match.ts' }, new AbortController().signal);

    expect(result).toEqual({
      ok: true,
      result: 'Read-result',
      appendix: activationBlock.text,
      activatedRules: ['r1'],
    });
  });

  it('leaves outcome.appendix unset when the call does not match any scoped rule', async () => {
    const mcp = makeMcpStub([]);
    const readTool = makeBuiltinTool('Read');
    const ruleActivator: RuleActivatorLike = {
      matchScopedRules: () => [],
      activate: async () => activationBlock,
    };
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator,
    });

    const result = await composite.callTool('Read', { path: 'no-match.ts' }, new AbortController().signal);

    expect(result).toEqual({ ok: true, result: 'Read-result' });
    expect('appendix' in result).toBe(false);
  });

  it('an MCP-routed call can also receive an appendix, composed the same way as a builtin call', async () => {
    const mcpCallTool = mock(async (): Promise<ToolCallOutcome> => ({ ok: true, result: 'mcp' }));
    const mcp = makeMcpStub([], mcpCallTool);
    const ruleActivator: RuleActivatorLike = {
      matchScopedRules: () => ['r1'],
      activate: async () => activationBlock,
    };
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [],
      ctx: { locationPath: '/work' },
      ruleActivator,
    });

    const result = await composite.callTool('close_session', {}, new AbortController().signal);

    expect(result).toEqual({
      ok: true,
      result: 'mcp',
      appendix: activationBlock.text,
      activatedRules: ['r1'],
    });
  });

  it('leaves outcome.appendix unset when activate() returns null (e.g. every matched name was size-skipped)', async () => {
    const mcp = makeMcpStub([]);
    const readTool = makeBuiltinTool('Read');
    const ruleActivator: RuleActivatorLike = {
      matchScopedRules: () => ['too-big'],
      activate: async () => null, // e.g. every matched name was size-skipped with nothing left over
    };
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [readTool],
      ctx: { locationPath: '/work' },
      ruleActivator,
    });

    const result = await composite.callTool('Read', { path: 'x.ts' }, new AbortController().signal);

    expect(result).toEqual({ ok: true, result: 'Read-result' });
    expect('appendix' in result).toBe(false);
  });

  it('polarity pin: a Bash call never receives an appendix, even with contrived path-shaped args -- fails if the matcher keys on args instead of tool name', async () => {
    const mcp = makeMcpStub([]);
    const bashTool = makeBuiltinTool('Bash');
    // The REAL RuleActivator, not a stub: this is what actually decides
    // whether a call can match, and its match table is keyed on tool NAME. A
    // catch-all glob would match virtually any path if the matcher looked at
    // `args` first, so this is the shape a broken (args-first) implementation
    // would get wrong.
    const catchAllRule: ScopedRule = { name: 'catch-all', origin: '/rules/catch-all.md', globs: ['**/*'] };
    const ruleActivator = new RuleActivator({
      scopedRules: [catchAllRule],
      gitRoot: '/work',
      cwd: '/work',
      remainingBudgetBytes: 1_000_000,
    });
    const composite = new CompositeToolExecutor({
      mcp,
      builtins: [bashTool],
      ctx: { locationPath: '/work' },
      ruleActivator,
    });

    const result = await composite.callTool(
      'Bash',
      { path: 'anything.ts', file_path: 'anything.ts', command: 'ls' },
      new AbortController().signal,
    );

    expect(result).toEqual({ ok: true, result: 'Bash-result' });
    expect('appendix' in result).toBe(false);
  });
});
