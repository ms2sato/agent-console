# Claude Code SDK (Agent SDK) POC Results

Investigation for [#241](https://github.com/ms2sato/agent-console/issues/241): Replace Claude Code CLI with `@anthropic-ai/claude-agent-sdk`.

## Package Info

- **Package**: `@anthropic-ai/claude-agent-sdk` (formerly `@anthropic-ai/claude-code`)
- **Tested version**: 0.2.29
- **Runtime**: Bun 1.3.5

## POC Source Code

All POC scripts are located in [`/poc/claude-code-sdk/`](../../poc/claude-code-sdk/).

Run with: `cd poc/claude-code-sdk && bun install && bun run <script>.ts`

## POC Summary

| # | Test | File | Result | Key Finding |
|---|------|------|--------|-------------|
| 1 | Basic query | `basic.ts` | OK | `query()` returns async generator yielding `system` → `assistant` → `result` |
| 2 | Streaming | `streaming.ts` | OK | `includePartialMessages: true` yields `stream_event` with `content_block_delta` per token |
| 3 | Tool use | `structured.ts` | OK | `assistant` messages contain `tool_use` blocks; SDK handles tool execution loop internally |
| 4 | Abort | `abort.ts` | OK | `AbortController` stops execution immediately; throws `"process aborted by user"` |
| 5 | Resume | `resume.ts` | OK | `resume: sessionId` preserves full conversation context across separate `query()` calls |
| 6 | Concurrent | `concurrent.ts` | OK | `Promise.all` with 3 queries runs in parallel (5.1s total vs ~10s sequential) |
| 7 | Error handling | `error-handling.ts` | OK | Errors surface as `is_error: true` on result message + thrown Error on process exit |
| 8 | Process count | `process-check2.ts` | **Important** | Each `query()` spawns a separate Claude Code child process (3 queries = +3 pids) |
| 9 | UUID availability | `uuid-check.ts` | OK | All message types (system, stream_event, assistant, result) have a `uuid` field |
| 10 | Resume replay | `resume-messages.ts` | **No replay** | `resume` does not re-yield past messages. Only new turn's messages are returned. History must be stored externally |
| 11 | AskUserQuestion (default) | `ask-user.ts` | **Auto-resolved** | SDK auto-responds with placeholder `"Answer questions?"`. Does not pause for real user input |
| 11b | AskUserQuestion (PreToolUse modify) | `ask-user-hook.ts` | **Cannot inject answer** | `modify` with `answers` field does not change the tool_result |
| 11c | AskUserQuestion (PreToolUse block) | `ask-user-block.ts` | **Works** | `{ decision: "block", reason: "user's answer" }` injects the answer as tool_result. Claude correctly interprets it |

| 12 | SDK↔CLI session sharing | `session-share2.ts` | **Works** | CLI's `--resume <session_id>` can continue an SDK session. Same session store is shared internally |

## Session Sharing Between SDK and CLI

SDK and CLI share the same internal session store. A conversation started via SDK `query()` can be continued by CLI `--resume <session_id>`, and vice versa (`-c` also picks up the latest SDK session).

**Switching challenge: history data format mismatch.**
- SDK Worker stores structured `SDKMessage[]` (JSON with typed blocks)
- PTY Worker stores raw terminal output bytes (ANSI escape sequences)
- When switching from SDK→PTY mid-conversation, past SDK messages cannot be rendered in xterm.js
- When switching from PTY→SDK, past terminal output cannot be parsed into structured messages
- The conversation *context* (what Claude knows) is preserved, but the *display history* for the UI is incompatible between the two formats

## Message Flow

A single `query()` call yields messages in this order:

```
system (init)        → session_id, cwd, tools, model, etc.
assistant            → Claude's response with content blocks (text / tool_use / thinking)
user (auto)          → tool_result (when tools are used, SDK handles this internally)
assistant            → next response (multi-turn continues automatically)
...
result               → final summary with cost, usage, duration, num_turns
```

## Message Types

### `system` (init)

```typescript
{
  type: "system",
  subtype: "init",
  session_id: string,    // Use with `resume` option for conversation continuity
  cwd: string,
  tools: string[],       // Available tools list
  model: string,         // e.g. "claude-opus-4-5-20251101"
  mcp_servers: [],
  permissionMode: string,
  apiKeySource: string,  // "none" when using claude login OAuth
}
```

### `assistant`

```typescript
{
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: string },
      { type: "tool_use", name: string, input: object },
      { type: "thinking", thinking: string },  // when extended thinking is enabled
    ],
    usage: { input_tokens, output_tokens, cache_read_input_tokens, ... }
  },
  session_id: string,
}
```

### `stream_event` (when `includePartialMessages: true`)

```typescript
{
  type: "stream_event",
  event: {
    type: "content_block_delta",
    delta: { type: "text_delta", text: string }
  }
}
// Other event types: message_start, content_block_start, content_block_stop, message_delta, message_stop
```

### `result`

```typescript
{
  type: "result",
  subtype: "success" | "error_during_execution",
  is_error: boolean,
  result: string | undefined,
  duration_ms: number,
  total_cost_usd: number,
  num_turns: number,
  session_id: string,
  usage: { input_tokens, output_tokens, ... },
}
```

## Key Options

```typescript
query({
  prompt: string,
  options: {
    allowedTools: string[],         // Restrict available tools. [] = no tools
    cwd: string,                    // Working directory
    maxTurns: number,               // Limit conversation turns
    includePartialMessages: boolean,// Enable streaming events
    abortController: AbortController,// Cancel execution
    resume: string,                 // session_id to continue conversation
    permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan",
    model: string,                  // Override model
    systemPrompt: string,           // Custom system prompt
  },
})
```

## Process Model

**Each `query()` call spawns an independent Claude Code child process.**

Verified by monitoring `pgrep` during concurrent execution:
- Before: 42 pids
- During 3 concurrent `query()` calls: 45 pids (+3)
- After completion: 42 pids (processes cleaned up)

This means the SDK does NOT multiplex multiple sessions within a single process. The architecture is fundamentally the same as spawning CLI processes directly—one process per active conversation.

## Error Behavior

| Scenario | Behavior |
|----------|----------|
| Empty prompt | `result.is_error = true` with API error message, then process exits with code 1 |
| Invalid session_id for resume | `result.subtype = "error_during_execution"`, then process exits with code 1 |
| Abort via AbortController | Throws `Error("Claude Code process aborted by user")` |
| maxTurns = 0 | Normal completion (assistant responds once, then stops) |

All errors are catchable via try/catch around the async generator loop.

## Authentication

The SDK automatically uses OAuth tokens from `claude login`. No API key configuration needed.
- `apiKeySource: "none"` in system init message confirms OAuth is used
- `ANTHROPIC_API_KEY` env var takes precedence if set
