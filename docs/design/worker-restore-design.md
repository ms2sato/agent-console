# Worker Restore Design Document

## Issue

After server restart, PTY workers (agent/terminal) appear in the UI as tabs but display a blank screen. This is because the persisted worker metadata is returned to the client, but the actual PTY process no longer exists.

## Background

### Current Behavior (Problem)

1. Server restarts, PTY processes are terminated
2. `toPublicSession()` returns persisted worker metadata (tabs appear in UI)
3. User clicks on a PTY worker tab
4. WebSocket connection is established
5. `session.workers.find()` finds the worker (from persisted metadata)
6. `attachWorkerCallbacks()` is called, but `getWorker()` returns `undefined` (no internal worker)
7. No callbacks are attached, no output is sent
8. Screen remains blank

### Related Existing Method

`restartAgentWorker` exists for explicit user-initiated restarts:

| Aspect | `restartAgentWorker` | `restoreWorker` (new) |
|--------|---------------------|----------------------|
| **User Action** | Settings menu → "Restart Session" button | Click on worker tab after server restart |
| **Dialog** | "New Session" or "Continue (-c)" selection | None (automatic) |
| **Intent** | User explicitly wants to restart | User just wants to open the tab |
| **Prerequisite** | PTY process is running | PTY process does not exist |
| **Kill Process** | `existingWorker.pty.kill()` | Not needed |
| **Data Source** | `InternalWorker` | `PersistedWorker` |
| **Caller** | REST API `/restart` | WebSocket `onOpen` |

## Solution

Add a new method `restoreWorker` that transparently restores PTY workers when WebSocket connection is established and the internal worker does not exist.

## Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. User: Click on worker tab in browser                             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Client: Establish WebSocket connection                           │
│    /ws/session/:sessionId/worker/:workerId                          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. routes.ts onOpen: getSession(sessionId)                          │
│    → toPublicSession() includes worker metadata from persistence    │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. routes.ts onOpen: session.workers.find(w => w.id === workerId)   │
│    → Persisted worker is found ✓                                    │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. routes.ts onOpen: For PTY workers (agent/terminal)               │
│    → Call sessionManager.restoreWorker(sessionId, workerId)         │
│       (Only performs restore if internal worker does not exist)     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. SessionManager.restoreWorker():                                  │
│    a. getWorker() to check internal worker → does not exist         │
│    b. Get PersistedWorker from persistenceService                   │
│    c. Call initializeAgentWorker() or initializeTerminalWorker()    │
│    d. session.workers.set() to add to Map                           │
│    e. persistSession() to save new PID                              │
│    f. Return InternalWorker                                         │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 7. routes.ts onOpen: Continue normal connection processing          │
│    - attachWorkerCallbacks()                                        │
│    - getWorkerOutputBuffer() → send history                         │
│    - getWorkerActivityState() → send activity                       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 8. Client: Terminal displays output                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### New Method: `SessionManager.restoreWorker()`

```typescript
restoreWorker(sessionId: string, workerId: string): InternalWorker | null {
  const session = this.sessions.get(sessionId);
  if (!session) return null;

  // If internal worker already exists, return it
  const existingWorker = session.workers.get(workerId);
  if (existingWorker) return existingWorker;

  // Get persisted worker metadata
  const metadata = persistenceService.getSessionMetadata(sessionId);
  const persistedWorker = metadata?.workers.find(w => w.id === workerId);
  if (!persistedWorker) return null;

  // Only restore PTY workers (agent/terminal)
  if (persistedWorker.type === 'git-diff') return null;

  let worker: InternalWorker;

  if (persistedWorker.type === 'agent') {
    worker = this.initializeAgentWorker({
      id: workerId,
      name: persistedWorker.name,
      createdAt: persistedWorker.createdAt,
      sessionId,
      locationPath: session.locationPath,
      agentId: persistedWorker.agentId,
      continueConversation: true,  // Continue existing session
    });
  } else {
    worker = this.initializeTerminalWorker({
      id: workerId,
      name: persistedWorker.name,
      createdAt: persistedWorker.createdAt,
      locationPath: session.locationPath,
    });
  }

  session.workers.set(workerId, worker);
  this.persistSession(session);

  return worker;
}
```

### Changes to `routes.ts`

In the `onOpen` handler for PTY workers, call `restoreWorker` before `attachWorkerCallbacks`:

```typescript
// PTY-based worker handling (agent/terminal)
// Restore worker if it doesn't exist internally (e.g., after server restart)
const restoredWorker = sessionManager.restoreWorker(sessionId, workerId);
if (!restoredWorker) {
  // Worker could not be restored
  const errorMsg: WorkerServerMessage = {
    type: 'exit',
    exitCode: 1,
    signal: null,
  };
  ws.send(JSON.stringify(errorMsg));
  ws.close();
  return;
}

// Continue with normal processing...
```

## Notes

- Agent workers are restored with `continueConversation: true` to continue the existing session
- Terminal workers are restored as new shell sessions (history is lost, but this is expected after server restart)
- Git-diff workers do not need restoration as they don't use PTY
- If internal worker already exists (normal browser reload), `restoreWorker` returns the existing worker without creating a new one
