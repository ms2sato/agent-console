# Session & Worker Design Document

## Issue

GitHub Issue #18: Shell tabs should persist across page reload

## Goals

1. Persist shell tabs (now called Workers) across page reload
2. Unify Claude session and shell management under a single architecture
3. Design for future extensibility (Diff viewer, Markdown preview, etc.)

## Concept Model

```
Repository (registered Git repository)
└── Worktree (physical directory, managed by git)
    └── Session (work session - multiple allowed per worktree)
        └── Worker (work unit - multiple allowed per session)

QuickSession (not tied to repository/worktree)
└── Worker
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Repository** | Registered Git repository |
| **Worktree** | Git worktree (physical directory) |
| **Session** | Work session tied to a location (directory) |
| **Worker** | Work unit within a session (Agent, Terminal, etc.) |

### Session Types

- **WorktreeSession**: Tied to a Repository and Worktree. Has branch management features.
- **QuickSession**: Tied only to a directory path. No repository/worktree management.

### Worker Types (Current & Future)

| Type | Description | Has PTY | Has ActivityDetector |
|------|-------------|---------|---------------------|
| AgentWorker | AI Agent (Claude Code, etc.) | Yes | Yes |
| TerminalWorker | Plain shell | Yes | No |
| GitDiffWorker | Git diff viewer | No | No |
| [EmbeddedAgentWorker](../glossary.md#embeddedagentworker) | Agent Console's own in-process LLM-loop agent (OpenAI-compatible providers, incl. local LLMs) | No (streams NDJSON events over stdout instead) | No (own `activityState`, driven by loop-reported state, not PTY output-pattern detection) |
| MarkdownWorker (future) | Markdown preview | No | No |
| WebWorker* (future) | Embedded website | No | No |

*Note: `WebWorker` name conflicts with browser API. Consider `EmbeddedWebWorker` or `BrowserWorker`.

## Type Definitions

### Common Types (packages/shared)

```typescript
// Agent activity state (detected by parsing output)
type AgentActivityState =
  | 'active'    // Working (output continuing)
  | 'idle'      // Waiting (prompt displayed)
  | 'asking'    // Waiting for user input (question/permission)
  | 'unknown';  // Unknown (initial state)

type SessionStatus = 'active' | 'inactive';
```

### Session Types (packages/shared)

```typescript
// ========== Session ==========

interface SessionBase {
  id: string;
  locationPath: string;      // Working directory (always required)
  status: SessionStatus;
  createdAt: string;
  workers: Worker[];
}

interface WorktreeSession extends SessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;        // Worktree identifier (e.g., path or branch)
}

interface QuickSession extends SessionBase {
  type: 'quick';
  // No repositoryId or worktreeId
}

type Session = WorktreeSession | QuickSession;
```

### Worker Types (packages/shared)

```typescript
// ========== Worker ==========

interface WorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

interface AgentWorker extends WorkerBase {
  type: 'agent';
  agentId: string;  // References AgentDefinition.id (e.g., 'claude-code-builtin')
}

interface TerminalWorker extends WorkerBase {
  type: 'terminal';
}

interface GitDiffWorker extends WorkerBase {
  type: 'git-diff';
  baseCommit: string;  // Comparison base commit hash (calculated at creation)
}

// Future worker types
interface MarkdownWorker extends WorkerBase {
  type: 'markdown';
  filePath: string;  // File to preview
}

// Current implementation
type Worker = AgentWorker | TerminalWorker | GitDiffWorker;

// Future (extensible)
// type Worker = AgentWorker | TerminalWorker | GitDiffWorker | MarkdownWorker | ...;
```

Note: `agentId` references an `AgentDefinition` which contains the command to run (e.g., `claude`), activity detection patterns, and continue args (e.g., `['-c']`).

### Server Internal Types

```typescript
// ========== Internal Worker (with PTY) ==========

interface InternalWorkerBase {
  id: string;
  name: string;
  createdAt: string;
  onData: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
}

interface InternalPtyWorkerBase extends InternalWorkerBase {
  pty: pty.IPty;
  outputBuffer: string;
}

interface InternalAgentWorker extends InternalPtyWorkerBase {
  type: 'agent';
  agentId: string;
  activityState: AgentActivityState;
  activityDetector: ActivityDetector;
  onActivityChange?: (state: AgentActivityState) => void;
}

interface InternalTerminalWorker extends InternalPtyWorkerBase {
  type: 'terminal';
}

type InternalWorker = InternalAgentWorker | InternalTerminalWorker;

// ========== Internal Session ==========

interface InternalSessionBase {
  id: string;
  locationPath: string;
  status: SessionStatus;
  createdAt: string;
  workers: Map<string, InternalWorker>;
}

interface InternalWorktreeSession extends InternalSessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
}

interface InternalQuickSession extends InternalSessionBase {
  type: 'quick';
}

type InternalSession = InternalWorktreeSession | InternalQuickSession;
```

## Persistence Structure

### File: `~/.agent-console/sessions.json`

```json
[
  {
    "id": "session-abc-123",
    "type": "worktree",
    "locationPath": "/path/to/worktree",
    "repositoryId": "repo-1",
    "worktreeId": "wt-feature-branch",
    "serverPid": 12345,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "workers": [
      {
        "id": "worker-1",
        "type": "agent",
        "name": "Claude",
        "agentId": "claude-code-builtin",
        "pid": 23456,
        "createdAt": "2025-01-01T00:00:00.000Z"
      },
      {
        "id": "worker-2",
        "type": "terminal",
        "name": "Terminal 1",
        "pid": 23457,
        "createdAt": "2025-01-01T00:00:05.000Z"
      }
    ]
  },
  {
    "id": "session-def-456",
    "type": "quick",
    "locationPath": "/some/random/directory",
    "serverPid": 12345,
    "createdAt": "2025-01-01T01:00:00.000Z",
    "workers": [
      {
        "id": "worker-3",
        "type": "agent",
        "name": "Claude",
        "agentId": "claude-code-builtin",
        "pid": 34567,
        "createdAt": "2025-01-01T01:00:00.000Z"
      }
    ]
  }
]
```

### Persistence Types

```typescript
interface PersistedWorkerBase {
  id: string;
  name: string;
  pid: number;
  createdAt: string;
}

interface PersistedAgentWorker extends PersistedWorkerBase {
  type: 'agent';
  agentId: string;
}

interface PersistedTerminalWorker extends PersistedWorkerBase {
  type: 'terminal';
}

type PersistedWorker = PersistedAgentWorker | PersistedTerminalWorker;

interface PersistedSessionBase {
  id: string;
  locationPath: string;
  serverPid: number;
  createdAt: string;
  workers: PersistedWorker[];
}

interface PersistedWorktreeSession extends PersistedSessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
}

interface PersistedQuickSession extends PersistedSessionBase {
  type: 'quick';
}

type PersistedSession = PersistedWorktreeSession | PersistedQuickSession;
```

## WebSocket Endpoints

### Current (to be deprecated)

- `GET /ws/terminal/:sessionId` - Connect to Claude session
- `GET /ws/terminal-new` - Create new Claude session
- `GET /ws/shell` - Create new plain shell (destroyed on disconnect)
- `GET /ws/app` - App state sync

### Proposed

- `GET /ws/session/:sessionId/worker/:workerId` - Connect to specific worker
- `GET /ws/app` - App state sync (renamed from /ws/dashboard)

### WebSocket Messages

No changes to message types - they work per-worker:

```typescript
// Client -> Server
type WorkerClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'image'; data: string; mimeType: string };

// Server -> Client
type WorkerServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'history'; data: string }
  | { type: 'activity'; state: AgentActivityState };  // Agent workers only
```

## REST API

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create session (optionally with primary agent worker) |
| GET | `/api/sessions/:id` | Get session details including workers |
| DELETE | `/api/sessions/:id` | Delete session and all workers |
| POST | `/api/sessions/:id/restart` | Restart session (recreate agent worker with -c) |

### Workers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions/:sessionId/workers` | List workers in session |
| POST | `/api/sessions/:sessionId/workers` | Create new worker |
| DELETE | `/api/sessions/:sessionId/workers/:workerId` | Delete specific worker |

### Request/Response Types

```typescript
// Create session
interface CreateWorktreeSessionRequest {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
  locationPath: string;
  agentId?: string;              // If provided, create primary agent worker
  continueConversation?: boolean;
}

interface CreateQuickSessionRequest {
  type: 'quick';
  locationPath: string;
  agentId?: string;
  continueConversation?: boolean;
}

type CreateSessionRequest = CreateWorktreeSessionRequest | CreateQuickSessionRequest;

interface CreateSessionResponse {
  session: Session;
}

// Create worker
interface CreateAgentWorkerRequest {
  type: 'agent';
  name?: string;
  agentId: string;
}

interface CreateTerminalWorkerRequest {
  type: 'terminal';
  name?: string;
}

type CreateWorkerRequest = CreateAgentWorkerRequest | CreateTerminalWorkerRequest;

interface CreateWorkerResponse {
  worker: Worker;
}
```

## Session Memo

Each session has at most one Markdown memo, stored server-side as a single
file (`MemoService`, see [glossary.md § Memo](../glossary.md#memo) for the
full concept summary). Two REST endpoints expose it:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions/:id/memo` | Read the session's memo. `{ content: string \| null }` -- `null` means no memo exists. |
| PUT | `/api/sessions/:id/memo` | Write (or delete) the session's memo. Body: `{ content: string }` (`UpdateSessionMemoRequestSchema`). Response: `{ content: string \| null }`, same shape as GET. |

**Ownership (Issue #1569, R5).** `PUT` requires the authenticated user to be
either the session's owner (`session.createdBy === authUser.id`) or, for a
[SharedSession](../glossary.md#sharedsession), any authenticated user
(`sharedAccountRegistry.isSharedUserId(session.createdBy)`). Otherwise the
route returns 403. This is a single check with no `AUTH_MODE` branch --
single-user mode's `authUser.id` trivially equals every session's
`createdBy`, so the same code path is correct in both modes (same precedent
as `PATCH /api/embedded-agents/:id`'s creator-only check).

**Empty-content deletes (R4).** A `PUT` whose `content.trim()` is empty
after trimming deletes the memo file (via `SessionManager.deleteMemo`)
rather than writing an empty string to disk -- an on-disk empty file would
make `readMemo` return `''` forever, which is never `null` and therefore
never renders as "no memo exists". The route returns `{ content: null }` in
this case.

**Realtime broadcast.** Both the write and delete paths fire the
`memo-updated` app-socket message (`{ type: 'memo-updated', sessionId,
content }`, `MemoUpdatedSchema` in
`packages/shared/src/schemas/app-server-message.ts`) after the underlying
file operation succeeds. **On the wire, `content: ''` means "the memo was
deleted"** -- the schema's `content` field is a plain (non-nullable)
`string`; `null` is a REST-response-only value and never appears in the
broadcast. Clients must not conflate the two: a REST `GET`/`PUT` response
uses `null` for "no memo", while the broadcast uses `''` for the same state.

**Concurrent-edit policy (R6, last-write-wins).** The memo editor does not
merge concurrent edits. If the panel receives a `memo-updated` broadcast
while the user has unsaved local edits, it keeps the user's typed text as
the source of truth (never silently overwrites it) and shows a "Load
latest" affordance so the user can explicitly discard their draft and pull
the newer content. A `PUT` always overwrites whatever is currently on disk
-- there is no conflict detection or optimistic-concurrency check at the
API level. (Client-side implementation of the affordance is out of scope
for this document's server-focused sections; see the memo panel component.)

## Server Architecture

### Before

```
SessionManager  -> Manages Claude PTY processes (1:1 Session:PTY)
ShellManager    -> Manages plain Shell PTY processes (separate)
```

### After

```
SessionManager  -> Manages Sessions (containers for workers)
  └── Internally manages Workers (all PTY processes)

ShellManager    -> Removed (merged into SessionManager)
```

### SessionManager Interface

```typescript
class SessionManager {
  // Session lifecycle
  createSession(request: CreateSessionRequest): Session;
  getSession(sessionId: string): Session | undefined;
  deleteSession(sessionId: string): boolean;
  getAllSessions(): Session[];

  // Worker lifecycle
  createWorker(sessionId: string, request: CreateWorkerRequest): Worker;
  getWorker(sessionId: string, workerId: string): InternalWorker | undefined;
  deleteWorker(sessionId: string, workerId: string): boolean;

  // Worker I/O
  attachWorkerCallbacks(sessionId: string, workerId: string, callbacks: WorkerCallbacks): boolean;
  detachWorkerCallbacks(sessionId: string, workerId: string): boolean;
  writeWorkerInput(sessionId: string, workerId: string, data: string): boolean;
  resizeWorker(sessionId: string, workerId: string, cols: number, rows: number): boolean;
  getWorkerOutputBuffer(sessionId: string, workerId: string): string;

  // Agent-specific
  getWorkerActivityState(sessionId: string, workerId: string): AgentActivityState | undefined;
  restartAgentWorker(sessionId: string, workerId: string, continueConversation: boolean): boolean;
}
```

## Server Startup Behavior

### Session Inheritance on Restart

When the server starts, it performs the following steps in order:

1. **Initialize Sessions** (`initializeSessions`)
   - Load all sessions from `sessions.json`
   - For each session:
     - If `serverPid` is alive (another server instance is running): Skip (don't inherit)
     - If `serverPid` is dead or missing: Inherit the session
   - For inherited sessions:
     - Kill any orphan worker processes that are still alive
     - Update `serverPid` to the current server's PID
     - Save the updated session to persistence

2. **Cleanup Orphan Processes** (`cleanupOrphanProcesses`)
   - After `initializeSessions`, all sessions that should be inherited have been claimed
   - This step handles any remaining edge cases (e.g., sessions from other dead servers that weren't inherited)

### Key Behaviors

| Scenario | Server A Session | Server B Session |
|----------|------------------|------------------|
| Server A restarts | Inherited by new Server A | Not touched |
| Server A dies, Server C starts | Inherited by Server C | Not touched |
| Both servers die, Server D starts | Inherited by Server D | Inherited by Server D |

### serverPid Field

The `serverPid` field in `sessions.json` tracks which server instance owns each session:

- When a session is created: `serverPid` = current server's PID
- When a session is inherited on restart: `serverPid` is updated to the new server's PID
- Used to determine if a session should be inherited (dead PID) or left alone (alive PID)

This design supports:
- Single server restart (sessions are preserved)
- Multiple server instances (each server manages its own sessions)
- Orphan cleanup (dead server's sessions are inherited by the next server to start)

## Migration Strategy

### Data Migration

Old `sessions.json` format:
```json
[{ "id": "...", "worktreePath": "...", "pid": 123, ... }]
```

Detection logic:
```typescript
function isOldFormat(session: unknown): boolean {
  return typeof session === 'object' && session !== null &&
    (!('type' in session) || !('workers' in session));
}
```

Migration logic (runs automatically on server startup):
```typescript
function migrateSession(old: OldPersistedSession): PersistedSession {
  return {
    id: old.id,
    type: old.repositoryId === 'default' ? 'quick' : 'worktree',
    locationPath: old.worktreePath,
    repositoryId: old.repositoryId !== 'default' ? old.repositoryId : undefined,
    worktreeId: old.repositoryId !== 'default' ? old.worktreePath : undefined,
    serverPid: old.serverPid,
    createdAt: old.createdAt,
    workers: [{
      id: `${old.id}-agent`,
      type: 'agent',
      name: 'Claude',
      agentId: 'claude-code-builtin',
      pid: old.pid,
      createdAt: old.createdAt,
    }],
  };
}
```

Note: Migration happens in-memory when loading sessions. The new format is written back on next save.

## Future Extensibility

### Adding New Worker Types

1. Add type to `Worker` union in shared types
2. Add `Internal*Worker` type if needed
3. Implement worker-specific logic in SessionManager
4. Add UI component for the worker type

### Example: GitDiffWorker (implemented)

`GitDiffWorker` was originally sketched here as a hypothetical future worker type; it has since been implemented and is now part of the current `Worker` union (see the table above). The snippet below shows the actual shape, which followed the same extension steps listed above:

```typescript
// Type (packages/shared/src/types/worker.ts)
interface GitDiffWorker extends WorkerBase {
  type: 'git-diff';
  baseCommit: string;  // Comparison base commit hash (calculated at creation)
}

// Internal (no PTY, uses git commands; packages/server/src/services/worker-types.ts)
interface InternalGitDiffWorker extends InternalWorkerBase {
  type: 'git-diff';
  baseCommit: string;
  // File watcher and callbacks managed by git-diff-handler.ts
}
```

The architecture supported this without major changes - just extending the union types and adding the implementation.
