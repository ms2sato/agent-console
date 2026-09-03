/**
 * Merges builtin subprocess-local tools with MCP tools behind a single
 * `ToolExecutor`, so `AgentLoop` (tool-source-agnostic) doesn't need to know
 * which tools are local and which are remote.
 */

import type { ToolExecutor, ToolCallOutcome } from '../mcp.js';
import type { ToolDefinition } from '../providers/types.js';
import type { RuleActivatorLike } from '../rule-activation.js';
import type { BuiltinTool, BuiltinToolContext } from './index.js';

export interface CompositeToolExecutorDeps {
  mcp: ToolExecutor;
  builtins: BuiltinTool[];
  ctx: BuiltinToolContext;
  /**
   * Phase B (#1343 R2): lazy scoped-rule activation, applied uniformly to
   * EVERY dispatched call -- builtin or MCP alike. The activator itself
   * decides, keyed on tool name, whether a call can ever produce a match
   * (see rule-activation.ts's match table), so no special-casing is needed
   * here beyond calling it the same way for every name.
   */
  ruleActivator: RuleActivatorLike;
  /** Fired once per colliding name when listTools() merges; caller logs it (stderr in the loop). */
  onNameCollision?: (name: string) => void;
}

/**
 * Merges builtin tools with MCP tools: name collisions resolve builtin-first
 * with a caller-supplied warn callback. `callTool()` dispatches locally for a
 * builtin name, otherwise routes through the wrapped MCP executor unchanged.
 */
export class CompositeToolExecutor implements ToolExecutor {
  constructor(private readonly deps: CompositeToolExecutorDeps) {}

  async listTools(): Promise<ToolDefinition[]> {
    const mcpTools = await this.deps.mcp.listTools();
    const builtinNames = new Set<string>(this.deps.builtins.map((t) => t.name));
    const filteredMcp = mcpTools.filter((t) => {
      if (builtinNames.has(t.name)) {
        this.deps.onNameCollision?.(t.name);
        return false;
      }
      return true;
    });
    return [...this.deps.builtins.map((t) => t.definition), ...filteredMcp];
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallOutcome> {
    const builtin = this.deps.builtins.find((t) => t.name === name);
    let outcome: ToolCallOutcome;
    if (builtin) {
      try {
        outcome = await builtin.execute(args, this.deps.ctx, signal);
      } catch (err) {
        outcome = { ok: false, result: err instanceof Error ? err.message : String(err) };
      }
    } else {
      outcome = await this.deps.mcp.callTool(name, args, signal);
    }

    const matched = this.deps.ruleActivator.matchScopedRules(name, args);
    if (matched.length === 0) return outcome;

    const activation = await this.deps.ruleActivator.activate(matched);
    return activation === null ? outcome : { ...outcome, appendix: activation.text };
  }
}
