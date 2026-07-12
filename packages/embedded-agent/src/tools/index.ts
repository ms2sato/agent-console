/**
 * Registry of builtin subprocess-local tools (Read/Glob/Grep in FF-1a; Bash is
 * a valid tool name but has no implementation until FF-1b).
 */

import type { EmbeddedAgentToolName } from '@agent-console/shared';
import { DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS } from '@agent-console/shared';
import type { ToolDefinition } from '../providers/types.js';
import { readTool } from './read.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';

export interface BuiltinToolContext {
  /**
   * Confinement root — the session's locationPath. Deliberately narrow: no
   * apiKey, no MCP token, no env — a builtin tool's execution scope cannot
   * observe provider credentials or the MCP bearer token by construction.
   */
  locationPath: string;
}

export interface BuiltinToolResult {
  ok: boolean;
  result: string;
}

export interface BuiltinTool {
  name: EmbeddedAgentToolName;
  definition: ToolDefinition;
  execute(args: unknown, ctx: BuiltinToolContext): Promise<BuiltinToolResult>;
}

/**
 * Registry of IMPLEMENTED builtin tools. `Bash` is a valid
 * `EmbeddedAgentToolName` (enum lands in FF-1a for schema/migration/UI
 * atomicity) but has no entry here yet — its implementation ships in FF-1b.
 * Selecting it in `enabledTools` is a currently-inert no-op until then.
 */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [readTool, globTool, grepTool];

const BUILTIN_TOOLS_BY_NAME = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

/**
 * Resolve a definition's raw `enabledTools` (as delivered in the init
 * command) into the concrete builtin tools to expose to the provider. Applies
 * the undefined -> default rule here (in the subprocess), since this is where
 * the merge with MCP tools happens. `[]` legitimately resolves to zero tools.
 */
export function resolveEnabledBuiltinTools(
  enabledTools: EmbeddedAgentToolName[] | undefined,
): BuiltinTool[] {
  const names = enabledTools ?? DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS;
  const tools: BuiltinTool[] = [];
  for (const name of names) {
    const tool = BUILTIN_TOOLS_BY_NAME.get(name);
    if (tool) tools.push(tool);
  }
  return tools;
}
