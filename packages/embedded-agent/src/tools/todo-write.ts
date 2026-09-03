/**
 * Builtin `TodoWrite` tool: lets the agent publish a live task list, shown to
 * the user as a progress panel.
 *
 * The input shape below is deliberately IDENTICAL to the Claude Agent SDK's
 * own native `TodoWriteInput` (`sdk-tools.d.ts`): `{ todos: { content,
 * status, activeForm }[] }`. `claude-sdk` does NOT route through this file --
 * measured against the resolved CLI (Issue #1575; see
 * `docs/design/embedded-agent-sdk-engine.md` §4.1/§5.2), `TodoWrite` is
 * silently dropped from that engine's native tool catalog rather than being
 * reachable simply by appearing in the `tools` allowlist. `sdk-engine.ts`
 * instead serves the SAME contract via an in-process SDK MCP server
 * (`createSdkTodoWriteTool`, mirroring `Compact`'s own MCP-served shape),
 * importing `TodoWriteArgsSchema` and `summarize` from this file rather than
 * duplicating them. Matching the shape here means one client-side renderer
 * (`TodoPanel`) can consume `tool-call` events from either engine without a
 * translation layer.
 *
 * Unlike every other builtin tool in this directory, validation uses valibot
 * rather than the hand-rolled `parseArgs` pattern -- deliberate, so the
 * accepted shape is pinned against a schema rather than reconstructed by hand
 * to match the SDK's type declaration.
 *
 * State (`todos`) lives in this factory's closure, NOT a module-level
 * singleton like the other five builtin tools: it is per-incarnation only (a
 * fresh subprocess must start with an empty list), so `createTodoWriteTool()`
 * is called fresh by `resolveEnabledBuiltinTools` on every invocation rather
 * than being registered as a shared instance in `BUILTIN_TOOLS` (see
 * index.ts). `createSdkTodoWriteTool` in `sdk-engine.ts` mirrors this same
 * per-incarnation-closure shape for the claude-sdk engine.
 */

import * as v from 'valibot';
import type { BuiltinTool, BuiltinToolContext, BuiltinToolResult } from './types.js';

const TodoStatusSchema = v.picklist(['pending', 'in_progress', 'completed']);

const TodoItemSchema = v.object({
  content: v.string(),
  status: TodoStatusSchema,
  activeForm: v.string(),
});

/**
 * Exported so `sdk-engine.ts`'s `createSdkTodoWriteTool` can validate the
 * claude-sdk engine's MCP-served `TodoWrite` call through the SAME schema,
 * rather than re-declaring it -- both engines must reject a malformed
 * `todos` payload with the identical message.
 */
export const TodoWriteArgsSchema = v.object({
  todos: v.array(TodoItemSchema),
});

export type TodoItem = v.InferOutput<typeof TodoItemSchema>;

/**
 * Exported for the same reason as `TodoWriteArgsSchema` above: `sdk-engine.ts`
 * composes the identical summary text for the claude-sdk engine's MCP-served
 * tool result.
 */
export function summarize(todos: TodoItem[]): string {
  const total = todos.length;
  const pending = todos.filter((t) => t.status === 'pending').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const completed = todos.filter((t) => t.status === 'completed').length;
  return `Todo list updated: ${total} items (${pending} pending, ${inProgress} in progress, ${completed} completed)`;
}

/**
 * Exported so `sdk-engine.ts`'s `createSdkTodoWriteTool` publishes this SAME
 * unnamespaced name to the SDK's `tool()` factory, which the SDK then
 * namespaces to `mcp__console__TodoWrite` (`SDK_TODO_WRITE_TOOL_NAME`,
 * packages/shared/src/types/embedded-agent.ts) -- mirroring
 * `COMPACT_TOOL_NAME` in compact-tool.ts.
 */
export const TODO_WRITE_TOOL_NAME = 'TodoWrite';

/**
 * Exported so `sdk-engine.ts`'s `createSdkTodoWriteTool` publishes the
 * IDENTICAL description to the model, rather than an independently-worded
 * copy that could drift from this one.
 */
export const TODO_WRITE_TOOL_DESCRIPTION =
  "Update the agent's task list, shown to the user as a live progress panel. " +
  'Replaces the entire list on each call — pass the full set of todos, not just changed ones. ' +
  "Use status: 'in_progress' for the task currently being worked (normally exactly one), " +
  "activeForm should be a present-continuous phrasing (e.g. 'Running tests') shown while a task " +
  "is in_progress, and content an imperative phrasing (e.g. 'Run tests') shown otherwise.";

/**
 * Constructs a fresh `TodoWrite` tool instance with its own private state.
 * Call once per incarnation -- see this file's header comment.
 */
export function createTodoWriteTool(): BuiltinTool {
  let todos: TodoItem[] = [];

  async function execute(
    args: unknown,
    _ctx: BuiltinToolContext,
    signal?: AbortSignal,
  ): Promise<BuiltinToolResult> {
    // Small win, not a real interruption: this is a pure synchronous update
    // with no async work to interrupt, but checking right before applying it
    // avoids racing an already-aborted turn's result into the conversation
    // (mirrors write.ts's pre-check).
    if (signal?.aborted) {
      return { ok: false, result: 'aborted' };
    }

    const parsed = v.safeParse(TodoWriteArgsSchema, args);
    if (!parsed.success) {
      return { ok: false, result: parsed.issues.map((issue) => issue.message).join('; ') };
    }

    // Full replace, not merge -- an empty `todos: []` legitimately clears the
    // list to zero items.
    todos = parsed.output.todos;

    return { ok: true, result: summarize(todos) };
  }

  return {
    name: TODO_WRITE_TOOL_NAME,
    definition: {
      name: TODO_WRITE_TOOL_NAME,
      description: TODO_WRITE_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full, replacing set of todo items',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Imperative-form task description, e.g. "Run tests"' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current state of this task',
                },
                activeForm: {
                  type: 'string',
                  description: 'Present-continuous phrasing shown while status is in_progress, e.g. "Running tests"',
                },
              },
              required: ['content', 'status', 'activeForm'],
            },
          },
        },
        required: ['todos'],
      },
    },
    execute,
  };
}
