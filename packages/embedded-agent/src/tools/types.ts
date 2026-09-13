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
  /**
   * Additional confinement roots (besides `locationPath`) that the `Read`
   * tool alone may open — the shared message-attachment upload directory.
   * Still carries no secrets. `write.ts` / `edit.ts` / `glob.ts` / `grep.ts`
   * deliberately never forward this to `resolveConfinedPath`, so they
   * continue to reject any path under it. (`write.ts` / `edit.ts` DO forward
   * the separate {@link memoryRoot} field -- a different field precisely so
   * the two contracts cannot be conflated by a future edit that widens
   * "extra roots" as one list.)
   */
  attachmentRoots?: string[];
  /**
   * Memory layer (epic #1636 Phase 2): the worker's server-owned memory
   * directory (`init.context.memoryDir`), an additional confinement root
   * that `read.ts` / `write.ts` / `edit.ts` forward to `resolveConfinedPath`
   * -- readable, writable, AND editable, unlike an attachment. `glob.ts` /
   * `grep.ts` deliberately never forward it: the index is the discovery
   * mechanism, not a directory search (see the design's "Why Glob/Grep are
   * excluded"). No new tool name, so `enabledTools` stays the single
   * mutation policy -- a definition with `Write`/`Edit` off has read-only
   * memory.
   */
  memoryRoot?: string;
}

export interface BuiltinToolResult {
  ok: boolean;
  result: string;
}

export interface BuiltinTool {
  name: EmbeddedAgentToolName;
  definition: ToolDefinition;
  /**
   * `signal` is optional and call-scoped (sourced from `AgentLoop`'s per-turn
   * `AbortController`, forwarded unchanged by `CompositeToolExecutor.callTool`)
   * — deliberately NOT folded into `BuiltinToolContext`, which stays a fixed
   * per-session confinement root. An implementation that ignores `signal`
   * simply never observes an abort; the never-throws contract still applies
   * either way (see `BuiltinToolResult`'s callers).
   */
  execute(args: unknown, ctx: BuiltinToolContext, signal?: AbortSignal): Promise<BuiltinToolResult>;
}
