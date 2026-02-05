# Session Pause/Resume Design

## Goal

Enable users to free up memory by pausing sessions while preserving all session data for later resumption. Currently, "Stop Session" deletes the session entirely, forcing users to recreate sessions and lose metadata like titles. The goal is to provide a lightweight way to manage resource usage without losing work context.

**Key outcomes:**
- Users can pause sessions to free memory (PTY processes terminated)
- All session metadata (title, worker configuration, output history) is preserved
- Users can resume sessions seamlessly with the same session ID
- Clear distinction between Active and Paused states in the UI

## Background

### Current Behavior (Problem)

The current "Stop Session" and "Restore" flow has these issues:

1. **Stop Session** calls `deleteSession()` which:
   - Kills all PTY processes
   - Deletes session from memory
   - **Deletes session from database**
   - **Deletes worker output files**

2. **Restore** (on worktree rows) creates a **new session**:
   - New session ID
   - Title must be re-entered
   - Previous session metadata is lost

3. **Memory consumption**: Sessions with "Open" button consume memory because:
   - Session object exists in `SessionManager.sessions` Map
   - PTY processes are running for each worker
   - Output buffers are held in memory

### Terminology Confusion

Current UI uses inconsistent terminology:
- "Stop Session" → Actually deletes the session
- "Restore" → Actually creates a new session
- "Open" vs "Restore" → Confusing distinction

## Design

### Scope

**In scope:** Worktree Sessions only

**Out of scope (for now):** Quick Sessions
- Quick Sessions continue to use Stop = Delete behavior
- Paused Quick Sessions would have no natural display location in the current UI
- This can be revisited in the future if needed

### Session States (Worktree Sessions)

```
┌──────────────────────────────────────────────────────────────────┐
│                         Session States                            │
├────────────────────────────────┬─────────────────────────────────┤
│         Active                 │           Paused                │
├────────────────────────────────┼─────────────────────────────────┤
│ • In memory (SessionManager)   │ • NOT in memory                 │
│ • PTY processes running        │ • No PTY processes              │
│ • serverPid = current PID      │ • serverPid = null              │
│ • Shown in sidebar             │ • Shown in dashboard only       │
│ • Button: "Open"               │ • Button: "Resume"              │
│ • Menu: "Pause"                │ • (No menu - not active)        │
└────────────────────────────────┴─────────────────────────────────┘
```

### State Transitions

```
                    ┌─────────┐
      Create ──────►│ Active  │◄────── Resume
                    └────┬────┘
                         │
                       Pause
                         │
                         ▼
                    ┌─────────┐
                    │ Paused  │
                    └─────────┘
                         │
                       Delete (optional, for cleanup)
                         │
                         ▼
                      (Gone)
```

### Data Preservation

| Data | After Pause | After Resume |
|------|-------------|--------------|
| Session ID | Preserved | Same ID restored |
| Title | Preserved in DB | Restored |
| Created timestamp | Preserved in DB | Restored |
| Worker configuration | Preserved in DB | Restored (new PTY spawned) |
| Terminal output history | Preserved in files | Restored |
| Claude conversation | Preserved in worktree `.claude/` | Continued with `-c` |

### Database Schema

No schema changes required. Use existing `serverPid` field:

```typescript
interface PersistedSession {
  id: string;
  type: 'worktree' | 'quick';
  locationPath: string;
  title?: string;
  createdAt: string;
  serverPid: number | null;  // null = Paused, number = Active
  workers: PersistedWorker[];
  // ...
}
```

### API Changes

#### New Endpoint: Pause Session

```
POST /api/sessions/:id/pause
Response: { success: true }
```

Server behavior:
1. Kill all PTY processes
2. Keep session in database
3. Set `serverPid = null`
4. Remove from in-memory `sessions` Map
5. **Do NOT delete worker output files**
6. Broadcast `session-paused` event

#### New Endpoint: Resume Session

```
POST /api/sessions/:id/resume
Response: { session: Session }
```

Server behavior:
1. Load session from database
2. Create in-memory session object
3. Restore workers (spawn new PTY processes with `continueConversation: true`)
4. Set `serverPid = current PID`
5. Broadcast `session-resumed` event

#### Deprecate: Delete for Pause Intent

The existing `DELETE /api/sessions/:id` remains for actual deletion, but UI should use "Pause" for the common case of freeing memory.

### UI Changes

#### Session Settings Menu (Active Session)

```
┌─────────────────────┐
│ Edit Session        │
│ Restart Agent       │
│ ─────────────────── │
│ Pause               │  ← Replaces "Stop Session"
│ ─────────────────── │
│ Delete Worktree     │
└─────────────────────┘
```

#### Dashboard (Paused Session)

Worktree row shows "Resume" button instead of "Restore":

```
┌─────────────────────────────────────────────────────────────┐
│ ○ My Feature Branch                          [Resume] [Del] │
│   /path/to/worktree                                         │
└─────────────────────────────────────────────────────────────┘
```

When resumed, shows "Open" button:

```
┌─────────────────────────────────────────────────────────────┐
│ ● My Feature Branch                          [Open]   [Del] │
│   /path/to/worktree                                         │
└─────────────────────────────────────────────────────────────┘
```

#### Sidebar

Only Active sessions appear in sidebar. Paused sessions do not appear.

### WebSocket Events

#### session-paused

```typescript
{
  type: 'session-paused',
  sessionId: string
}
```

Clients should:
- Remove session from sidebar
- If viewing the paused session, show "Session Paused" message and redirect

#### session-resumed

```typescript
{
  type: 'session-resumed',
  session: Session
}
```

Clients should:
- Add session to sidebar
- Update dashboard to show "Open" instead of "Resume"

## Migration

### Existing "Stopped" Sessions

After deployment, existing sessions that were "stopped" (deleted) cannot be recovered. This is expected - the new behavior only applies going forward.

### Server Restart Handling

On server restart:
1. Load all sessions from database
2. Sessions with `serverPid = null` remain Paused
3. Sessions with `serverPid = old PID` are treated as Paused (orphaned)
4. No sessions are Active until explicitly resumed or opened via WebSocket

This is consistent with existing behavior where sessions need to be restored after server restart.

## Implementation Notes

### Pause Implementation

```typescript
async pauseSession(id: string): Promise<boolean> {
  const session = this.sessions.get(id);
  if (!session) return false;

  // Notify clients before killing workers
  notifySessionPaused(id);

  // Kill all PTY workers (but don't delete output files)
  for (const worker of session.workers.values()) {
    if (worker.type !== 'git-diff') {
      this.workerManager.killWorker(worker);
    }
  }

  // Remove from memory
  this.sessions.delete(id);

  // Update database: set serverPid to null
  await this.sessionRepository.update(id, { serverPid: null });

  // Broadcast state change
  this.sessionLifecycleCallbacks?.onSessionPaused?.(id);

  return true;
}
```

### Resume Implementation

```typescript
async resumeSession(id: string): Promise<Session | null> {
  // Check not already active
  if (this.sessions.has(id)) {
    return this.toPublicSession(this.sessions.get(id)!);
  }

  // Load from database
  const persisted = await this.sessionRepository.findById(id);
  if (!persisted) return null;

  // Create in-memory session
  const session = this.createInternalSessionFromPersisted(persisted);
  this.sessions.set(id, session);

  // Restore workers (spawn PTY processes)
  for (const persistedWorker of persisted.workers) {
    await this.restoreWorker(id, persistedWorker.id);
  }

  // Update serverPid
  await this.sessionRepository.update(id, { serverPid: process.pid });

  // Broadcast state change
  this.sessionLifecycleCallbacks?.onSessionResumed?.(this.toPublicSession(session));

  return this.toPublicSession(session);
}
```

## Future Considerations

- **Quick Session pause support**: Add pause/resume for Quick Sessions with dedicated UI section for paused Quick Sessions
- Auto-pause idle sessions after configurable timeout
- Visual indicator in dashboard showing memory usage per session
- Bulk pause/resume operations
- Session state persistence across server updates (graceful shutdown)
