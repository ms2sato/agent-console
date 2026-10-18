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

No schema changes to sessions are required. Use existing `serverPid` field (the pause and resume commands add two columns to `repositories`, see [Pause and resume commands](#pause-and-resume-commands)):

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
Response: { success: true, pauseCommandResult?: HookCommandResult }
```

Server behavior:
1. Kill all PTY processes
2. Run the repository's **pause command** (worktree sessions only; see [Pause and resume commands](#pause-and-resume-commands)). The pause always completes: the command's outcome is returned in `pauseCommandResult` and is never a reason to refuse the pause
3. Keep session in database
4. Set `serverPid = null`
5. Remove from in-memory `sessions` Map
6. **Do NOT delete worker output files**
7. Broadcast `session-paused` event

#### New Endpoint: Resume Session

```
POST /api/sessions/:id/resume
Response: { session: Session, resumeCommandResult?: HookCommandResult }
```

Server behavior:
1. Load session from database
2. Run the repository's **resume command** (worktree sessions only), after the worktree path is confirmed to exist and before any worker starts, so the resources the workers need are back first. The resume always completes: a failed command is reported in `resumeCommandResult`
3. Create in-memory session object
4. Restore workers (spawn new PTY processes with `continueConversation: true`)
5. Set `serverPid = current PID`
6. Broadcast `session-resumed` event

### Pause and resume commands

A repository can configure a `pause_command` and a `resume_command` (columns on `repositories`, edited beside the setup and cleanup commands). They are shell commands run through the same `executeHookCommand` as the setup and cleanup commands, with the same template variables (`WORKTREE_NUM`, `BRANCH`, `REPO`, `WORKTREE_PATH`). The motivating case is a worktree that started Docker containers: `docker compose stop` on pause and `docker compose start` on resume.

- **Triggers.** `POST /api/sessions/:id/pause` is the only pause path (there is no MCP pause tool and no auto-pause), so that is where the pause command runs. Every resume goes through `resumeSessionInternal`, so the resume command lives there rather than in the route, behind a `runResumeCommand` flag: true for a user resume, false for the auto-resume at server start. Server-only restarts leave containers running and run no pause command, so running the resume command there would start things twice; the skip is logged at INFO per session. A server restart does not run the pause command: sessions become hibernated through `serverPid` handling and no pause call exists on that path (it becomes a row of the table below when graceful shutdown lands).
- **Failure.** Pause and resume always complete. The command's result (`success`, `output`, `error`) is returned in the response and the client shows a non-blocking failure dialog; success shows nothing.
- **Time box.** Unlike setup and cleanup, these two run under a time box: `serverConfig.SESSION_HOOK_COMMAND_TIMEOUT_MS`, default 60 s, overridable through the `SESSION_HOOK_COMMAND_TIMEOUT_MS` environment variable (a positive integer in milliseconds; anything else falls back to the default). A hanging command therefore cannot hang the pause request, which returns at the deadline on both branches. On a timeout the direct (single-user) branch signals the command's whole process tree as observed at the deadline (SIGTERM, then SIGKILL after a short grace), so a grandchild such as `sleep` does not outlive it; a process that re-parents itself or changes process group before the deadline can still escape. The elevated (multi-user) branch also returns at the deadline (the helper's cleanup, which waits for the pipes to close, finishes in the background), but the helper's own timeout kills only the spawned shell and leaves the same grandchild residue: that gap is tracked in [Issue #2203](https://github.com/ms2sato/agent-console/issues/2203). The time box therefore bounds a user-initiated resume only; the auto-resume at server start runs no command and cannot be stalled by one. Setup and cleanup keep their current no-timeout behaviour.
- **Identity.** In multi-user mode the command runs as the session owner via `resolveSpawnUsername(session.createdBy, userRepository)`, the resolver resume already uses for its worker spawns (shared sessions: the shared account). Single-user mode spawns directly.
- **Scope.** Worktree sessions only (quick sessions cannot be paused). A session whose repository is gone, or whose command is empty, runs nothing and returns no result.

#### Surfaces

| operation | repository settings form | repository detail page | repository card | MCP `update_repository` | MCP `list_repositories` | REST `PATCH /api/repositories/:id` | pause/resume result UI |
|---|---|---|---|---|---|---|---|
| configure pause command | do: textarea "Pause Command (optional)", placeholder `docker compose stop` | do: "Pause Command" row | not here: the card shows only the setup command today (same as cleanup) | do: `pauseCommand` param, echoed in the result | not here: cleanup is not listed either | do: `pauseCommand` in the request schema | -- |
| configure resume command | do: textarea "Resume Command (optional)", placeholder `docker compose start` | do: "Resume Command" row | not here (same) | do: `resumeCommand` | not here | do | -- |
| run pause command | -- | -- | -- | not here: no MCP pause exists | -- | -- (`POST /:id/pause` runs it) | do: on `pauseCommandResult.success === false` the failure is recorded on the session's stop task in `SessionStopTasksContext` (root) and a non-blocking failure dialog renders at the root over the current page; the normal navigation is unchanged (it does not wait for the dialog); success shows nothing |
| run resume command | -- | -- | -- | not here | -- | -- (`POST /:id/resume` runs it) | do: the same root-level dialog on `resumeCommandResult.success === false`; every resume caller (session page, dashboard banner, sidebar) reports into the same slot; success shows nothing |
| run resume command on auto-resume at server start | -- | -- | -- | -- | -- | -- | not here: a server restart resumes workers only; the resume command runs only on a user resume, after its pause command (owner, 2026-10-18) |
| run on server shutdown / restart | -- | -- | -- | -- | -- | not here: no pause call exists on that path; becomes a row when graceful shutdown lands | -- |

Owner confirmation of the user-facing cells: owner-confirmed 2026-10-18.

Implementation notes for the two decisions above:

- **Where the failure is held.** The `session-paused` WebSocket frame reaches the client before the pause response, and the session page, which issued the request, unmounts when that frame arrives. State kept in the page or its dialog is therefore lost before the response carrying `pauseCommandResult` lands, so the failure lives at the root, where the pause task already lives.
- **Auto-resume at server start.** `initialize()` calls `resumeSession(id, false)`, so the resume command is skipped there while workers are still resumed; the REST resume passes the default `true`.

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

#### Pausing is a state

The pause command makes the window between the last worker kill and the removal of the session from memory as long as the command's time box, instead of a few awaits. In that window the session is still in memory with every PTY cleared, so anything that activates a worker would start it again behind the pause. The session manager therefore keeps a `pausing` entry per session from before the first worker is killed until the pause has settled (cleared in a `finally`, so a throwing command or a failed save also clears it), and:

- a second pause request **joins** the in-flight one and gets the same outcome (HTTP 200, not 409): a double click or a retry must not surface an error for an operation that is succeeding;
- worker activation entry points (`getAvailableWorker`, `restoreWorker`, `createWorker`, `activateEmbeddedAgentWorker`, `restartWorker`) are **refused** with `SessionPausingError` (HTTP 409); `restartAllAgentWorkers` skips the session and says why in its per-session result;
- a worker WebSocket opened in that window is closed with the existing `SESSION_PAUSED` code and the reason `Session is pausing`, which the client already treats as "do not reconnect";
- a resume request is not affected: the session is still in memory, so it returns the existing session and activates nothing.

A notification addressed to one of the session's embedded workers (a one-shot timer, a conditional wakeup, an inbound event) that fires inside the window fails delivery with `NOT_ACTIVATED`, because activation is refused; one second after the pause completes it fails with `not-found`, because the session has left memory. Both are dropped (an inbound event additionally leaves a failed notification row in the window and none afterwards), so the window changes the form of the loss, not whether it happens: a notification aimed at a paused session's worker is dropped with or without a pause command. Whether such notifications should be deferred until resume or dropped by design is an open question, tracked in [Issue #2204](https://github.com/ms2sato/agent-console/issues/2204).

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
