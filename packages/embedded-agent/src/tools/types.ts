/**
 * Shared type surface for builtin subprocess-local tools.
 *
 * Extracted from `index.ts` so tool implementations (`read.ts` / `glob.ts` /
 * `grep.ts`) can depend on these types WITHOUT depending on the registry
 * module that imports them (`index.ts`). Importing from `./index.js` there
 * created a circular dependency (index.ts -> read.ts/glob.ts/grep.ts -> back
 * to index.ts). This module has no runtime dependency on the registry or on
 * any tool implementation — pure type declarations only.
 */

import type { EmbeddedAgentToolName } from '@agent-console/shared';
import type { ToolDefinition } from '../providers/types.js';

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
