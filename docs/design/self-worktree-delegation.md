# Self-Worktree Delegation Design

An AI agent running on AgentConsole delegates part of its work to a new worktree—creating a session, sending a prompt, and monitoring completion—all through the AgentConsole API.

## Motivation

When an agent is working on a task and the user says "execute that in a new worktree," the agent currently has no way to do so. The user must manually create a worktree and session through the UI, then copy-paste the prompt. This design enables agents to programmatically self-delegate through the AgentConsole API.

### Use Cases

1. **Parallel subtask offloading**: "Implement the backend in a new worktree while I work on the frontend here"
2. **Review delegation**: "Create a new worktree and review the code changes from PR #123"
3. **Multi-branch work**: "Run the tests on main in a separate worktree"

## Current Architecture Context

### What the Agent Knows Today

Currently, an agent spawned by AgentConsole runs as a PTY process with:
- **Working directory**: The worktree path (e.g., `~/.agent-console/repositories/org/repo/worktrees/wt-003-ab12`)
- **Environment variables**: Parent process env (filtered), plus `__AGENT_PROMPT__` for the initial prompt
- **No self-awareness**: The agent has no knowledge of its own sessionId, workerId, the AgentConsole server address, or the repositoryId

### Relevant Existing API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/repositories/:id/worktrees` | POST | Create worktree (async, with `autoStartSession`) |
| `POST /api/sessions` | POST | Create session directly |
| `POST /api/sessions/:id/messages` | POST | Send message to worker |
| `GET /api/sessions/:id` | GET | Get session status |
| `GET /api/sessions` | GET | List all sessions |
| `WS /ws/session/:sessionId/worker/:workerId` | WS | Worker I/O stream |

### Key Flow: Worktree + Session Creation

The existing `POST /api/repositories/:id/worktrees` with `autoStartSession: true` and `mode: 'prompt'` already:
1. Generates branch name from prompt (via headless agent call)
2. Creates git worktree
3. Creates session with agent worker
4. Sends `initialPrompt` to the spawned agent
5. Broadcasts `worktree-creation-completed` via WebSocket

This is the primary flow to leverage.

## Design Decisions

### Decision 1: MCP as the integration mechanism

Provide MCP tools that the agent can use through Claude Code's native MCP tool interface.

**Why MCP over alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| **MCP** | Native tool integration, structured I/O, type-safe | Requires MCP endpoint implementation |
| **CLI tool** | Simple to implement | Parsing stdout, error handling awkward |
| **Direct curl** | Zero implementation | Fragile, hard to maintain, poor UX |
| **Claude Code hooks** | Event-driven | Not designed for agent-initiated actions; cannot return data |

### Decision 2: AgentConsole server itself as MCP server (SSE transport)

AgentConsole server exposes an MCP-compatible endpoint directly, rather than running a separate MCP server process.

**Alternatives considered and rejected:**

| Approach | Issue |
|----------|-------|
| **Separate MCP server process (stdio transport)** | Requires distributing a separate command binary (npm package, PATH setup, etc.). Unnecessary complexity. |
| **Writing `.claude/settings.local.json` to worktree** | Pollutes the user's worktree with git diff noise. Fundamentally problematic. |
| **CLI flags on commandTemplate** | Depends on Claude Code supporting `--mcp-config` flag. Couples agent definition to MCP setup. |

**Why SSE transport on AgentConsole server is best:**
- **No additional binary to distribute**: The AgentConsole server is already running
- **No worktree files modified**: Zero filesystem side effects
- **Direct access to internal state**: No need to call REST API from a child process; the MCP endpoint can access SessionManager, WorkerManager, etc. directly
- **Simple configuration**: Just a URL (`http://localhost:<port>/mcp`)

### Decision 3: Environment variables for agent self-awareness

Inject context into agent PTY processes via environment variables so the agent knows where it is running.

```typescript
// Added to processEnv in worker-manager.ts activateAgentWorkerPty()
const agentConsoleEnv = {
  AGENT_CONSOLE_BASE_URL: `http://localhost:${serverPort}`,
  AGENT_CONSOLE_SESSION_ID: sessionId,
  AGENT_CONSOLE_WORKER_ID: workerId,
  AGENT_CONSOLE_REPOSITORY_ID: repositoryId,  // For worktree sessions only
};
```

These serve two purposes:
1. **MCP tool context**: The MCP endpoint can use these to identify the calling agent (e.g., `repositoryId` for `delegate_to_worktree` so the agent doesn't need to specify it)
2. **Agent self-awareness**: The agent can reference its own session context in prompts/logging

### Decision 4: User registers MCP server URL in Claude Code settings

The user adds the AgentConsole MCP server to `~/.claude/settings.json` (user-level, one-time):

```json
{
  "mcpServers": {
    "agent-console": {
      "url": "http://localhost:3457/mcp"
    }
  }
}
```

**Notes:**
- One-time setup. Can be automated by an AgentConsole setup script.
- The port must match the AgentConsole server port. If the user changes the port, they update this URL accordingly.
- Multiple AgentConsole instances can coexist by registering multiple entries with different names:
  ```json
  {
    "mcpServers": {
      "agent-console": { "url": "http://localhost:3457/mcp" },
      "agent-console-2": { "url": "http://localhost:3458/mcp" }
    }
  }
  ```
- When Claude Code is launched **outside** AgentConsole (no `AGENT_CONSOLE_BASE_URL` env var), the MCP server endpoint simply returns no tools or appropriate error messages. This makes the configuration safe to leave in place globally.

## Architecture Overview

```
Agent (Claude Code in wt-002)
    │
    │ 1. Calls MCP tool: delegate_to_worktree
    │    (via SSE transport to AgentConsole server)
    ▼
AgentConsole Server (/mcp endpoint)
    │
    │ 2. Creates worktree (wt-003)
    │ 3. Creates session + agent worker
    │ 4. Sends initialPrompt to new agent
    │ 5. Returns result to MCP caller
    ▼
New Agent (Claude Code in wt-003)
    │
    │ 6. Executes the delegated task
    ▼
Agent (wt-002) can poll status via MCP tool: get_session_status
```

## MCP Tools

### 1. `delegate_to_worktree`

Create a new worktree, start a session, and send a prompt to a new agent.

```typescript
// Input
{
  prompt: string,             // The task description for the new agent
  baseBranch?: string,        // Base branch (defaults to repository default)
  branch?: string,            // Explicit branch name (skips auto-generation)
  agentId?: string,           // Agent to use (defaults to claude-code-builtin)
  title?: string,             // Session title
  useRemote?: boolean,        // Branch from origin/<base> if true
}
// Note: repositoryId is derived from AGENT_CONSOLE_REPOSITORY_ID env var
// so the agent doesn't need to know or specify it.

// Output
{
  sessionId: string,
  workerId: string,
  worktreePath: string,
  branch: string,
}
```

**Internal implementation**: Calls the existing worktree creation flow (`POST /api/repositories/:id/worktrees` equivalent) with `mode: 'prompt'` (or `mode: 'custom'` if branch is specified) and `autoStartSession: true`. Since the MCP endpoint runs inside the server process, it can call the service layer directly instead of going through HTTP.

**Async handling**: Worktree creation is asynchronous (git operations, optional branch name generation). The MCP tool waits for the `worktree-creation-completed` internal event before returning the result to the agent. Timeout: 120 seconds.

### 2. `get_session_status`

Check the status of a delegated session.

```typescript
// Input
{
  sessionId: string,
}

// Output
{
  sessionId: string,
  status: 'active' | 'inactive',
  title?: string,
  worktreeId?: string,
  workers: Array<{
    id: string,
    type: 'agent' | 'terminal' | 'git-diff',
    activityState: 'active' | 'idle' | 'asking' | 'unknown',
  }>,
}
```

### 3. `send_message_to_session`

Send a follow-up message to a delegated session's worker.

```typescript
// Input
{
  sessionId: string,
  workerId: string,
  message: string,
}

// Output
{
  success: boolean,
}
```

### 4. `list_sessions`

List active sessions (useful for discovering existing work).

```typescript
// Input
{}

// Output
{
  sessions: Array<{
    id: string,
    type: 'worktree' | 'quick',
    title?: string,
    worktreeId?: string,
    status: 'active' | 'inactive',
    workers: Array<{
      id: string,
      type: 'agent' | 'terminal' | 'git-diff',
      activityState: 'active' | 'idle' | 'asking' | 'unknown',
    }>,
  }>,
}
```

## Implementation Plan

### Phase 1: Environment Variable Injection

1. Inject `AGENT_CONSOLE_BASE_URL`, `AGENT_CONSOLE_SESSION_ID`, `AGENT_CONSOLE_WORKER_ID`, and `AGENT_CONSOLE_REPOSITORY_ID` into PTY process environment (`worker-manager.ts`)
2. Verify no conflicts with existing env filtering (`env-filter.ts`)

This alone enables agents to use `curl` for basic self-delegation, even without the MCP endpoint.

### Phase 2: MCP Endpoint on AgentConsole Server

1. Add `/mcp` SSE endpoint to the Hono server
2. Implement MCP protocol (tool listing, tool execution) using `@modelcontextprotocol/sdk` or equivalent
3. Implement tools: `delegate_to_worktree`, `get_session_status`, `send_message_to_session`, `list_sessions`
4. Direct service layer access (no internal HTTP calls)

### Phase 3: Enhanced Monitoring (Future)

1. **Output retrieval**: Tool to read recent output from delegated workers (leveraging existing worker output file system)
2. **Session lifecycle management**: Tools to pause/resume/stop delegated sessions
3. **Activity state subscription**: SSE-based notification when delegated agent state changes

## Security Considerations

### API Access Control

- **Localhost only**: The MCP endpoint listens on the same server as the rest of AgentConsole (localhost only, no external exposure)
- **Session isolation**: An agent can only interact with sessions on the same AgentConsole instance
- **No credential leakage**: Environment variables contain only `localhost:<port>`, no secrets

### Prompt Injection Risks

- The delegated prompt goes through the existing `initialPrompt` flow, which uses environment variable injection (not shell metacharacters)
- The MCP endpoint validates inputs before passing to the service layer

### Resource Limits

- Consider limiting the number of concurrent delegated sessions per agent
- Worktree creation is already rate-limited by git operations

## Open Questions

1. **Authentication**: Should the MCP endpoint require token-based auth?
   - Recommendation: Not initially. Localhost-only is sufficient for a local development tool. Revisit if AgentConsole gains remote access features.

2. **Output forwarding**: Should the parent agent be able to read the delegated agent's terminal output?
   - Recommendation: Yes, in Phase 3. The worker output file system already supports offset-based reads.

3. **Recursive delegation**: Should a delegated agent be able to further delegate?
   - Recommendation: Yes, with a configurable depth limit (default: 2). The env vars propagate naturally.

4. **Completion notification**: How should the parent agent know the delegated work is done?
   - Phase 2: Polling via `get_session_status`
   - Phase 3: SSE-based subscription for real-time notification

## Related Documents

- [Custom Agent Design](./custom-agent-design.md) - Agent definition and management
- [Session-Worker Design](./session-worker-design.md) - Session and worker architecture
- [Inbound Integration](./integration-inbound.md) - External event routing (similar pattern)
- [Outbound Integration](./integration-outbound.md) - Notification infrastructure
- [WebSocket Protocol](./websocket-protocol.md) - Real-time event communication
