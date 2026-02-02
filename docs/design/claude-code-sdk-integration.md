# Claude Code SDK Integration Design

Related: [#241](https://github.com/ms2sato/agent-console/issues/241) / [POC results](../research/claude-code-sdk-poc.md)

## Goal

Replace the Claude Code CLI + PTY approach with the Claude Code SDK (`@anthropic-ai/claude-agent-sdk`) to enable structured message handling and rich UI rendering.

## Current Architecture

```
User input → xterm.js → WebSocket (raw bytes) → PTY process (claude CLI) → raw text output
                                                                          ↓
                                                  ActivityDetector (regex on raw output)
```

- AgentWorker spawns a PTY process running `claude` CLI
- All output is unstructured terminal text (ANSI escape sequences)
- Activity detection relies on output rate and regex pattern matching
- Frontend renders everything via xterm.js terminal emulator

## Proposed Architecture

```
User input → Web UI → WebSocket (JSON) → SDK query() → structured messages
                                                       ↓
                                          message.type discriminator
                                          (system/assistant/stream_event/result)
```

- AgentWorker calls `query()` from the SDK instead of spawning a PTY
- Each `query()` still spawns a child process internally (1 process per active conversation)
- Output is structured JSON with typed message blocks (text, tool_use, thinking, etc.)
- Activity state is derived from message types rather than regex heuristics
- Frontend renders rich HTML (Markdown, syntax highlighting, collapsible sections)

## What Changes

### Server

| Component | Current (PTY) | Proposed (SDK) |
|-----------|---------------|----------------|
| **Process management** | `bun-pty` spawn | `query()` async generator (spawns child process internally) |
| **Cancellation** | `SIGTERM` to PTY | `AbortController.abort()` |
| **Session continuity** | CLI internal (PTY stays alive) | `resume: sessionId` option on `query()` |
| **Output format** | Raw terminal bytes | Typed JSON messages (`SDKMessage`) |
| **Activity detection** | Rate + regex heuristics | Deterministic: `assistant` = active, `result` = idle, `tool_use` = active |
| **User input** | Write bytes to PTY stdin | Pass as `prompt` string to next `query()` call |
| **Resize handling** | PTY resize | Not applicable (no terminal) |
| **WebSocket protocol** | `output` (raw text), `input` (raw text) | New message types for structured content |

### Frontend

| Component | Current | Proposed |
|-----------|---------|----------|
| **Rendering** | xterm.js (terminal emulator) | React components (Markdown, code blocks, etc.) |
| **User input** | Terminal keyboard events | Text input / textarea |
| **Message display** | Undifferentiated text stream | Distinct UI for text, thinking, tool_use, tool_result |
| **Dependencies** | `@xterm/xterm`, `@xterm/addon-*` | Markdown renderer, syntax highlighter |

### What Does NOT Change

- **Process model**: Still 1 process per active Agent Worker (SDK spawns child process per `query()`)
- **Session/Worker data model**: Sessions still contain Workers; Workers still belong to Sessions
- **Terminal Workers**: Remain PTY-based (plain shell sessions are unchanged)
- **App WebSocket (`/ws/app`)**: Session/worker lifecycle broadcasts remain the same
- **Worker WebSocket endpoint**: Same path, but message protocol changes for SDK-based workers

## Worker Type Coexistence

SDK integration introduces a new worker variant alongside existing types:

```
Worker
├── AgentWorker (PTY-based, legacy) → may be deprecated later
├── AgentWorker (SDK-based, new)    → structured messages
├── TerminalWorker (PTY-based)      → unchanged
└── GitDiffWorker (file watcher)    → unchanged
```

During migration, both PTY-based and SDK-based agent workers should coexist. The agent definition could specify which mode to use.

## SDK Worker Lifecycle

### Start

1. `SessionManager.createWorker()` creates an SDK-based AgentWorker
2. Worker holds an `AbortController` and `sessionId` (from SDK)
3. First `query()` call is made with the initial prompt
4. Async generator is iterated; each message is forwarded to connected WebSocket clients

### Conversation Turn

1. User sends a message via WebSocket
2. Server calls `query({ prompt: userMessage, options: { resume: sessionId } })`
3. Stream messages to frontend as they arrive
4. On `result` message, worker returns to idle state

### Stop / Cancel

1. Call `abortController.abort()` to stop the current `query()`
2. SDK throws `"process aborted by user"` error
3. Worker transitions to idle/stopped state

### Resume After Server Restart

1. Worker's `sessionId` is persisted
2. On reconnect, next user message resumes via `resume: sessionId`
3. SDK restores conversation context from its internal storage

## WebSocket Protocol (SDK Worker)

### Server → Client

```typescript
// Structured message from SDK
{ type: "sdk-message", message: SDKMessage }

// Activity state derived from message type
{ type: "activity", state: "active" | "idle" | "asking" }

// Worker exit / error
{ type: "exit", exitCode: number, signal: string | null }
{ type: "error", message: string, code: string }
```

### Client → Server

```typescript
// User sends a new message
{ type: "user-message", content: string }

// Cancel current execution
{ type: "cancel" }
```

Note: `input` (raw keystrokes), `resize`, and `image` messages are not used for SDK workers.

## Activity Detection (SDK Worker)

No heuristic needed. Activity state maps directly from message flow:

| SDK Event | Activity State |
|-----------|---------------|
| `query()` called | `active` |
| `stream_event` (content_block_delta) | `active` |
| `assistant` message with `tool_use` | `active` |
| `result` (success) | `idle` |
| `result` (error) | `idle` |
| SDK yields `AskUserQuestion` tool_use | `asking` (see note below) |

**AskUserQuestion handling** (verified via POC):
- The SDK auto-responds to `AskUserQuestion` with a placeholder if not intercepted
- Solution: Use `PreToolUse` hook with `decision: "block"` and `reason: "<user's answer>"`
- The `reason` string becomes the `tool_result` content, which Claude interprets as the user's answer
- Implementation pattern:
  1. Register `PreToolUse` hook for `AskUserQuestion` matcher
  2. In the hook, send the question payload to frontend via WebSocket
  3. Await the user's response (the hook callback is async, so it can await a Promise)
  4. Return `{ decision: "block", reason: userAnswer }`

## Design Decisions

1. **Worker type**: New `WorkerType` for SDK-based Claude Code workers. Not a generic mode flag on agents—this is Claude Code specific.

2. **Message storage & history sync**:
   - Server holds `SDKMessage[]` array per worker in-memory (analogous to PTY's `outputBuffer`)
   - Server also persists messages to file as JSONL (analogous to PTY's `workerOutputFileManager`)
   - On server restart, messages are restored from file into memory
   - Each SDKMessage has a `uuid` field (verified: all message types including `stream_event` have uuid)
   - Client caches messages in IndexedDB (analogous to PTY's terminal state cache)
   - On reconnect, client sends last received `uuid` as cursor
   - Server responds with messages after that cursor
   - This mirrors PTY's offset-based sync but uses uuid cursor instead of byte offset

3. **xterm.js**: Remains for TerminalWorker only. SDK Workers use React-based rich UI.

4. **Migration**: Full-stack implementation in one phase (SDK Worker + rich UI together).

## SDK ↔ PTY Session Sharing

SDK and CLI share the same internal session store (verified via POC #12). This enables switching between SDK Worker and PTY Agent Worker mid-conversation while preserving Claude's context.

**How it works:**
- SDK Worker creates a session → `session_id` is captured
- PTY Agent Worker can be launched with `claude --resume <session_id>`
- Claude retains full conversation context across the switch

**Challenge: history data format mismatch.**
- SDK Worker history = `SDKMessage[]` (structured JSON)
- PTY Worker history = raw terminal bytes (ANSI)
- These cannot be converted between each other
- On switch, the UI must either:
  - Show a "history before switch is not available in this view" placeholder
  - Or keep both histories and show the appropriate one per worker type

This is a UX design decision for a future phase. The backend plumbing (session_id sharing) is already feasible.

## Constraints and Risks

- **SDK spawns child processes**: No reduction in process count. Memory/CPU profile is similar to current approach.
- **SDK version coupling**: Tight dependency on `@anthropic-ai/claude-agent-sdk` API surface. Breaking changes require code updates.
- **Authentication**: SDK uses `claude login` OAuth. Third-party distribution would require API key auth (OAuth not allowed for third-party products per Anthropic policy).
- **Tool permission model**: `permissionMode` setting affects what the agent can do. Needs careful configuration for security.
