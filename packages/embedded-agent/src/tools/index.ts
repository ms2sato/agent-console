/**
 * Registry of builtin subprocess-local tools (Read/Glob/Grep in FF-1a; Bash in
 * FF-1b).
 */

import type { EmbeddedAgentToolName } from '@agent-console/shared';
import { DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS } from '@agent-console/shared';
import type { BuiltinTool } from './types.js';
import { readTool } from './read.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { bashTool } from './bash.js';

// Re-exported so existing consumers (composite-executor.ts, main.ts, test
// files) keep importing these types from './index.js' / '../index.js'
// unchanged. The types themselves live in ./types.js — see that file's
// header comment for why (avoiding a circular dependency with read/glob/grep).
export type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';

/**
 * Registry of IMPLEMENTED builtin tools. `Bash` stays OFF by default (see
 * `DEFAULT_EMBEDDED_AGENT_ENABLED_TOOLS` in @agent-console/shared) — a
 * definition must opt in explicitly via `enabledTools`.
 */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [readTool, globTool, grepTool, bashTool];

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
