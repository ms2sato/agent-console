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

  // Freeze timers and conditional wakeups first (every pause participant, in registration order)
  for (const p of this.pauseParticipants.values()) p.suspend(id);

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

**Timers and conditional wakeups are suspended by a pause.** `pauseSession` calls `suspend` on every pause participant first, synchronously, in registration order, before the pause notification and the worker kills, so no scheduled fire can be dispatched into the window or at a session that has left memory. A suspended timer keeps its backoff state (`fireCount`, step) and remembers the wait that was pending; a suspended wakeup stops polling, kills an in-flight check, and freezes its timeout. If the pause then fails and the session stays live, the rollback calls `resume` on the same participants in the same order. On a successful resume, after the session is back in memory, its workers are activated and `onSessionResumed` has run, each participant's `resume` is called in the same order and they are re-armed with the **remaining wait**: a timer with 70 s left when the pause began fires 70 s after the resume, and a wakeup runs one check immediately (so a condition that became true during the pause is reported without waiting an interval) and then at its interval, with its timeout continuing from the time that was left. Fires that would have happened during the pause are not replayed or counted, and the pause duration is excluded from every remaining wait. Suspended timers are still listed (`suspendedAt` is set) and count toward the per-session caps. A server restart while a session is paused restarts its persisted timers at the full base interval (the same contract as any restart); wakeups are volatile and are lost, as on any restart, and persisting them is out of scope. The mechanism is a set of named participants registered with `SessionManager.registerPauseParticipant(name, { suspend, resume })` (a duplicate name throws; `listPauseParticipants()` returns the names): `app-context.ts` registers `timer` first, then `conditional-wakeup`. The scheduler creation tools (`create_timer` and `create_conditional_wakeup`) refuse a session that is pausing or no longer live, so nothing is armed after the suspend ran. Each call is isolated: a participant that throws is logged at error level with its name and the session id and does not stop the others, because a pause must still complete. Resume participants are never called when the resume itself rolls back. The interactive process manager is intentionally a delete-only participant: a process started by a session keeps running through a pause (it is the agent's own command, bounded by its timeout and `MAX_PROCESSES_PER_SESSION`), and its output and exit notices, addressed to a paused session's worker, are deferred into the resume digest (`internal-process` is `defer`, see below). See invariant I-11 in `.claude/skills/architectural-invariants/SKILL.md`.

**Notifications addressed to a paused session's worker are deferred, not dropped.**

- *Storage.* A deferred notification is a row of `deferred_worker_notifications` (migration v55; `session_id` and `worker_id` cascade on delete, `reply_to_session_id` is set NULL when the sender session is deleted). The table is capped at 100 rows per session, FIFO: the 101st insert deletes the oldest row of that session in the same transaction (oldest by `created_at`, then by arrival order, the table's implicit rowid; the random `id` never orders, so rows sharing a millisecond keep the order they arrived in, in listings, in the eviction choice and in the digest) (a warn names the dropped kind). There is no time-based retention, rows live exactly as long as the session row, and nothing is coalesced (every process chunk keeps its own row). `kind` is constrained by the TypeScript type at write time, not by a `CHECK`.
- *Per-kind disposition.* `PAUSE_DISPOSITION` (`packages/server/src/services/pause-disposition.ts`) is the single table that lists kinds for this decision, typed `satisfies Record<PtyNotificationKind, ...>` so a new kind does not compile until it has a row. `defer`: `inbound-event`, `internal-message`, `internal-process`, `internal-todo-resolved`, `internal-todo-comment`, `internal-worker-interrupted`, `internal-paused-digest`. `suspended-at-source`: `internal-timer`, `internal-conditional-wakeup` (the pause participants stop the producer, so one arriving at the seam is a bug and is logged, not stored). `live-only`: `internal-review-comment`, `internal-reviewed`, `internal-agent-spawn-failed` (direct writers to an already-live worker that never call the seam). Producers do not defer themselves; `deliverWorkerNotification` is the only place.
- *Seam order.* `SessionManager.deliverWorkerNotification` decides in this order: (1) the session is pausing: a `defer` kind is stored and the call returns `{ ok: true, deferred: true }`, any other kind fails as before with one warn naming it; (2) the session is in memory: the live path, unchanged; (3) the session is not in memory: a persisted row that is paused (`serverPid` null, `recoveryState` not `orphaned`) with a worker of that id that can receive notifications defers a `defer` kind the same way; anything else is `not-found` as before. `send_session_message` writes its message file first, treats a deferred result as success, and skips the reply-instructions write (each digest entry carries a reply hint instead). A database error while storing a deferred row returns `{ ok: false, reason: 'deferral-failed' }` and is logged at error level (it is not reported as `not-found`, which would point an operator at the wrong cause); the process router treats any reason outside its two retryable ones as terminal, so no caller changes behavior.
- *The digest.* On resume each worker receives ONE `internal-paused-digest` notification (`composePausedDigest`, `packages/server/src/lib/paused-digest.ts`): a header (`pausedAt`, `resumedAt`, `count`, `omitted`, `path`, `summary`), a framing paragraph (these arrived while paused, some may need action, some may be stale, some may need confirming with the sender; timers and wakeups were suspended and resume after this digest), then one line per entry, oldest first, each rendered with its ORIGINAL arrival time (an `internal-message` entry from a still-existing sender also carries a reply hint). At most 50 entries and 6000 characters are shown; beyond either, the OLDEST entries are dropped, the header says `omitted=N` and the body starts with "N older entries omitted, full list at <path>". The char budget is the binding limit at typical entry sizes (measured ~175 chars per rendered entry on 2026-10-24, so about 34 entries fit); the entry cap is a backstop for short entries. If more inline content is wanted, raise the char budget, never the entry cap. The full list, untruncated and grouped by worker, is written BEFORE any row is deleted to `<session data>/deferred/<resumedAt>.md` (the read-more file; written even when nothing is omitted, kept with the session data directory), and `path` on every digest of that resume names it. A crash between the write and the delete leaves the rows for the next resume and a file that is a superset, never the reverse. The digest is delivered like any other PTY notification and inherits that behaviour; a resume into an untrusted folder shows the modal first and the digest's bytes go to it. A "TUI at prompt" detector shared by every PTY notification is the follow-up (Issue #2244, tagged with the readiness constants and revisited together; detector thresholds are tracked in #2245).
- *Readiness gate.* The flush first waits, for every worker that can receive notifications and even when there are zero rows, until the worker is ready. An agent PTY worker is ready when ALL hold: (a) its start command has been typed into the login shell (`worker.commandInjection`, also settled when the worker exits first, so a dead worker does not hold the flush); (b) at least `WORKER_READY_MIN_OUTPUT_BYTES = 2048` bytes of PTY output arrived after that (`worker.postInjectionOutputBytes`; the shell's echo of the typed command counts, bytes before the login-shell sentinel do not); (c) at least `WORKER_READY_SETTLE_MS = 3000` have passed since the last output chunk (`worker.lastOutputAt`; a timer re-armed on each chunk, no polling). The cap `WORKER_READY_CAP_MS = 60000` bounds the whole wait: on timeout it logs a warn and proceeds. If the PTY is gone after the injection the wait ends at once. Terminal and embedded-agent workers are ready immediately (`SessionManager.waitForWorkerReady`). The rule is agent-agnostic and does not involve the activity detector, whose rate threshold does not fire on a TUI's few large redraws (see the follow-ups below). Basis: the first post-injection chunk is the shell's echo (tens to a few hundred bytes), and the agent's own first frame arrives one process startup later (box drawing and colours, kilobytes). The byte floor separates the two, so a quiet gap between the echo and the first frame cannot pass the gate; the settle window separates a frame still being drawn, or a spinner (a chunk every few tens of ms), from a prompt at rest. The constants are injectable (`SessionManager` option `readiness: { minOutputBytes, settleMs, capMs }`) so tests and the `cat` E2E can use a low floor and a short cap. It then writes the read-more file, composes one digest per worker, deletes that worker's rows (one transaction per worker) and delivers through the seam, sequentially. A failed delivery is logged and the rows stay deleted: this is best effort, not a retry queue. If a new pause begins while the flush waits, it returns with the rows intact.
- *Ordering with the participants.* The resume request does not wait for the flush. The flush runs void-forwarded, and in its `finally` the pause participants' `resume` is called (re-arming timers and wakeups) only when the session is not pausing and is still live, checked in the same synchronous tick as the re-arm. A timer whose remaining wait reached 0 during the pause therefore fires after the digest delivery returned, never before it. Boot auto-resume flushes too; there the participant re-arm is a no-op and `restoreTimers` arms live sessions as before.
- *Digest race.* If a new pause begins between a worker's row deletion and its digest delivery, the pausing branch of the seam defers the digest itself as one row of kind `internal-paused-digest` (`source_id` is the read-more path); the next digest shows it as a single entry pointing at that file.
- *Inbound events.* `resolve-targets` treats a paused session like a live one (per-session loop, parent, and both designated-Orchestrator paths; recognised by membership in `getPausedSessions()`, orphaned excluded, hibernated-but-live sessions keep their skip). `AgentWorkerHandler` passes the inbound job id as `sourceId` and maps `deferred: true` to `handled`, so an `[inbound:*]` event for a paused session is stored as an `inbound-event` row (`source_id` = job id), its ledger row is `delivered`, and it appears in the resume digest. See [integration-inbound.md](./integration-inbound.md).

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

  // Re-arm suspended timers and wakeups with their remaining wait (same participant order)
  for (const p of this.pauseParticipants.values()) p.resume(id);

  return this.toPublicSession(session);
}
```

## Future Considerations

- **Quick Session pause support**: Add pause/resume for Quick Sessions with dedicated UI section for paused Quick Sessions
- Auto-pause idle sessions after configurable timeout
- Visual indicator in dashboard showing memory usage per session
- Bulk pause/resume operations
- Session state persistence across server updates (graceful shutdown)
