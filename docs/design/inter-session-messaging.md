# Inter-Session Messaging Design

File-based messaging system that enables any session to send messages to any other session, replacing the previous PTY-injection approach (`send_message_to_session`).

## Problem

### No inter-session communication

When an agent delegates work to another worktree via `delegate_to_worktree`, the delegating session has no way to know when the delegated work completes. The only option is polling `get_session_status`, which wastes tokens and is unreliable.

### PTY injection conflates user instructions with agent messages

The previous `send_message_to_session` wrote directly to the target worker's PTY stdin. The receiving agent (Claude Code) interpreted these messages as user instructions, causing:

- Abandonment of current work to respond to the "instruction"
- Confusion about who is giving instructions
- Inability to distinguish system messages from user input

PTY stdin should be reserved for human-to-agent communication only. Agent-to-agent communication requires a different channel.

## Design Overview

```
Session A                         Server                         Session B (Worker W)
    │                               │                               │
    │ send_session_message()        │                               │
    │ (MCP tool)                    │                               │
    │ ─────────────────────────────>│                               │
    │                               │                               │
    │                               │ 1. Resolve target worker      │
    │                               │ 2. Write message file:        │
    │                               │    messages/{B}/{W}/...       │
    │                               │ 3. PTY notification (signal): │
    │                               │    [inbound:message] ...      │
    │                               │ ─────────────────────────────>│
    │                               │                               │
    │  { messageId, path }          │                               │ Agent reads file
    │ <─────────────────────────────│                               │ at its own pace
    │                               │                               │
```

Key separation: **notification** (PTY, signal only) and **content** (file, agent reads at its own pace).

## Design Decisions

### Decision 1: File-based, not PTY-based

| Aspect | PTY Injection (old) | File-based (new) |
|--------|:---:|:---:|
| Agent confusion | Interprets as user instruction | Agent reads deliberately |
| Timing control | Push (interrupts agent) | Pull (agent reads when ready) |
| Content richness | Limited (raw text) | Unlimited (structured file) |
| Debuggability | Invisible (lost after scroll) | Persistent (file on disk) |

### Decision 2: Session-level, not parent-child specific

Any session can send a message to any other session. The system does not enforce or track parent-child relationships. Delegation hierarchy is expressed through message content, not infrastructure.

### Decision 3: Worker-level targeting

A session can have multiple agent workers. Messages are delivered to a specific worker within the target session.

```
~/.agent-console/messages/
  └── {sessionId}/
      └── {workerId}/
          ├── {timestamp}-{senderSessionId}.json
          └── {timestamp}-{senderSessionId}.json
```

- `toWorkerId` is optional in the MCP tool. If omitted, the server resolves the target automatically (see [Worker resolution](#worker-resolution-when-toworkerid-is-omitted)).
- PTY notification is sent only to the targeted worker, not all workers in the session.
- Each worker has its own message directory, so multiple agent workers in the same session receive messages independently.

### Decision 4: One message = one file

Each message is an individual file. This avoids concurrent write corruption when multiple sessions send messages to the same recipient simultaneously.

- File naming: `{timestamp}-{senderSessionId}.json`
- Atomic writes: write to temp file, then rename
- Concurrent safety: different files, no collision
- Ordering: timestamp prefix ensures chronological ordering within a directory

### Decision 5: MCP tool for sending

Sending is exposed as an MCP tool (`send_session_message`) rather than relying on agents to write files directly. This provides:

- **Discoverability**: Agents see the tool in their tool list and understand messaging is available
- **Correctness**: Server handles directory creation, atomic writes, file naming
- **Synchronous notification**: Since the MCP tool runs inside the server process, it can deliver PTY notifications immediately after writing the file—no file watcher needed

### Decision 6: PTY notification for receiving (signal only)

When a message is sent, the server immediately sends a minimal notification to the targeted worker's PTY. The notification contains only metadata, not the message content.

```
[inbound:message] source=session from={senderSessionId} summary="Message from session {senderTitle}" path=/absolute/path/to/message.json intent=triage
```

This reuses the `[inbound:TYPE]` format established by the GitHub webhook integration (see [integration-inbound.md](./integration-inbound.md)):

| Field | Description |
|-------|-------------|
| `source` | Always `session` (distinguishes from `github` etc.) |
| `from` | Sender's session ID |
| `summary` | Human-readable summary (sender's session title or ID) |
| `path` | Absolute path to the message file |
| `intent` | `triage` (agent should read and act) |

All field values are sanitized: control characters are stripped and double quotes are escaped, consistent with `AgentWorkerHandler` in the inbound event system.

The agent then reads the file at its own pace to get the actual content.

### Decision 7: No prescribed message format

The message content is free-form. The system does not enforce a schema. Agents determine what to write based on the context:

- Completion notification: `{ "status": "completed", "summary": "..." }`
- Question: `{ "type": "question", "content": "Should I use approach A or B?" }`
- Progress update: `{ "progress": "3/5 tasks done", "details": "..." }`

The calling agent includes content expectations in the delegation prompt if needed.

## MCP Tool

### `send_session_message` (replaces `send_message_to_session`)

```typescript
// Input
{
  toSessionId: string;       // Target session ID
  toWorkerId?: string;       // Target worker ID (optional)
  content: string;           // Message content (free-form)
}

// Output (success)
{
  messageId: string;         // File name of the created message
  path: string;              // Full path to the message file
}

// Output (error) — returned as MCP tool error with structured message
// - Session not found: "Session {toSessionId} not found"
// - Worker not found: "Worker {toWorkerId} not found in session {toSessionId}"
// - No agent workers: "Session {toSessionId} has no agent workers"
// - Multiple workers: "Session {toSessionId} has multiple agent workers
//     ({id1}, {id2}, ...). Specify toWorkerId explicitly.
//     Use get_session_status to discover available workers."
```

#### Worker resolution when `toWorkerId` is omitted

1. Find all agent workers in the target session
2. If exactly one agent worker exists, target it
3. If multiple agent workers exist, return an error listing the worker IDs

This avoids ambiguous delivery. The error message guides the sender to use `get_session_status` to discover workers and choose an explicit target.

The previous `send_message_to_session` (PTY injection) is removed and replaced by this tool.

## Server Implementation

### Message file management

When `send_session_message` is called:

1. Validate target session exists
2. Resolve target worker (explicit or sole agent worker; error if ambiguous)
3. Ensure directory exists: `~/.agent-console/messages/{sessionId}/{workerId}/`
4. Write message to temp file in the same directory
5. Atomic rename to final path: `{timestamp}-{senderSessionId}.json`
6. Deliver PTY notification to the target worker (synchronous, within the same MCP tool handler)
7. Optionally broadcast via app WebSocket for UI notification
8. Return message ID and path

### Notification delivery

Notification is delivered **synchronously** within the `send_session_message` MCP tool handler, immediately after the message file is written. The server has direct access to `SessionManager` and can write to the target worker's PTY.

No `fs.watch` or file watcher is required. The MCP tool handler is the sole mechanism for both file creation and notification delivery.

If the target worker's PTY is not available at the time of sending (e.g., session is hibernated), the message file is still written. The agent can discover unread messages by listing its message directory when it resumes.

### Integration with inbound event system

Message delivery reuses the pattern established by the inbound event handlers:

- PTY notification uses the same `[inbound:TYPE] key=value` format
- Control character sanitization applies (prevents terminal injection)
- Similar to `AgentWorkerHandler` but for inter-session messages instead of GitHub webhooks

### Cleanup

Message files are cleaned up when:

- A session is deleted → remove `~/.agent-console/messages/{sessionId}/` entirely
- A worker is deleted → remove `~/.agent-console/messages/{sessionId}/{workerId}/`

Message files are not automatically expired. Since messages are small and messaging frequency is low in typical usage, unbounded growth is not a practical concern. If this assumption proves wrong, a TTL-based cleanup can be added later.

## Use Cases

### Use Case 1: Parallel worktree delegation with local merge

A single task split across multiple worktrees to avoid conflicts. Each sub-task runs in its own worktree, and the parent merges results locally.

```
Parent Agent (Session P, Worker W):

  1. delegate_to_worktree({ prompt: "Fix backend auth. When done,
       use send_session_message to report the result to session {P}." })
     → returns { sessionId: A }

  2. delegate_to_worktree({ prompt: "Fix frontend auth. When done,
       use send_session_message to report the result to session {P}." })
     → returns { sessionId: B }

  3. Parent continues other work or waits.
     When children complete, PTY notifications arrive:

  4. PTY ← [inbound:message] source=session from=A summary="Message from Fix-backend" path=/.../P/W/...-A.json intent=triage
     → Parent reads file → { "status": "completed", "summary": "Backend auth refactored, 3 files changed" }

  5. PTY ← [inbound:message] source=session from=B summary="Message from Fix-frontend" path=/.../P/W/...-B.json intent=triage
     → Parent reads file → { "status": "completed", "summary": "Frontend auth refactored, 5 files changed" }

  6. git merge fix/auth-backend && git merge fix/auth-frontend
```

### Use Case 2: Multiple agent workers in one session

A session with two agent workers (e.g., a coder and a reviewer). An external session sends a message specifically to the reviewer.

```
External Agent:
  1. get_session_status({ sessionId: "target" })
     → workers: [
         { id: "w1", type: "agent", name: "Coder" },
         { id: "w2", type: "agent", name: "Reviewer" }
       ]

  2. send_session_message({
       toSessionId: "target",
       toWorkerId: "w2",          ← explicitly target the reviewer
       content: "Please review the changes on branch fix/auth"
     })
```

If the sender omits `toWorkerId` when multiple agent workers exist, the tool returns an error:
```
"Session target has multiple agent workers (w1, w2). Specify toWorkerId explicitly.
Use get_session_status to discover available workers."
```

### Use Case 3: Progress management with PR merge trigger (future: Layer 2)

A coordinator agent manages multiple independent tasks. Completion is triggered by PR merge events via GitHub webhook, not by file-based messaging.

This use case is handled by extending the existing inbound event system to route `pr:merged` events to the delegating session. See [integration-inbound.md](./integration-inbound.md) for the webhook infrastructure.

## Relationship with Existing Systems

| System | Purpose | Coexistence |
|--------|---------|-------------|
| Inbound events (GitHub webhooks) | External event notifications | Complementary. Webhooks handle CI/PR lifecycle; messages handle inter-agent communication |
| Outbound notifications (Slack) | Human notifications | Independent. Slack notifies humans; messages communicate between agents |
| App WebSocket | UI state synchronization | Complementary. WebSocket can broadcast message events for UI notification |

## Related Documents

- [Self-Worktree Delegation](./self-worktree-delegation.md) - MCP-based delegation architecture
- [Inbound Integration](./integration-inbound.md) - GitHub webhook event routing (similar delivery pattern)
- [WebSocket Protocol](./websocket-protocol.md) - Real-time client communication
- [Session-Worker Design](./session-worker-design.md) - Session lifecycle
