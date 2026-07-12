/**
 * Merges builtin subprocess-local tools with MCP tools behind a single
 * `ToolExecutor`, so `AgentLoop` (tool-source-agnostic) doesn't need to know
 * which tools are local and which are remote.
 */

import type { ToolExecutor, ToolCallOutcome } from '../mcp.js';
import type { ToolDefinition } from '../providers/types.js';
import type { BuiltinTool, BuiltinToolContext } from './index.js';

export interface CompositeToolExecutorDeps {
  mcp: ToolExecutor;
  builtins: BuiltinTool[];
  ctx: BuiltinToolContext;
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
    if (builtin) {
      return builtin.execute(args, this.deps.ctx);
    }
    return this.deps.mcp.callTool(name, args, signal);
  }
}
