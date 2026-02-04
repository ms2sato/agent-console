# Session Pause/Resume Implementation

## Overview

Implement session pause and resume functionality to allow users to free memory while preserving session data.

**Design Document:** [docs/design/session-pause-resume.md](../design/session-pause-resume.md)

**Scope:** Worktree Sessions only. Quick Sessions continue to use Stop = Delete behavior (see Future Considerations).

## Tasks

### Phase 1: Backend - Core Functionality

#### 1.1 Add `pauseSession` method to SessionManager

- [ ] Implement `pauseSession(id: string): Promise<boolean>`
  - **Reject if session type is 'quick'** (Quick Sessions use Stop = Delete)
  - Kill PTY processes without deleting output files
  - Remove session from in-memory Map
  - Update database: set `serverPid = null`
  - Do NOT call `CLEANUP_SESSION_OUTPUTS` job
- [ ] Add `onSessionPaused` callback to `SessionLifecycleCallbacks`
- [ ] Add unit tests

#### 1.2 Add `resumeSession` method to SessionManager

- [ ] Implement `resumeSession(id: string): Promise<Session | null>`
  - Load session from database
  - Create in-memory session object
  - Restore all workers with `continueConversation: true`
  - Update database: set `serverPid = process.pid`
- [ ] Add `onSessionResumed` callback to `SessionLifecycleCallbacks`
- [ ] Add unit tests

#### 1.3 Add REST API endpoints

- [ ] `POST /api/sessions/:id/pause` - Pause a session
- [ ] `POST /api/sessions/:id/resume` - Resume a session
- [ ] Add integration tests

### Phase 2: Backend - WebSocket Events

#### 2.1 Add new WebSocket message types

- [ ] Define `session-paused` message type in shared types
- [ ] Define `session-resumed` message type in shared types

#### 2.2 Implement broadcasting

- [ ] Broadcast `session-paused` when session is paused
- [ ] Broadcast `session-resumed` when session is resumed
- [ ] Update app-handler to handle new events

### Phase 3: Frontend - API Client

#### 3.1 Add API functions

- [ ] `pauseSession(sessionId: string): Promise<void>`
- [ ] `resumeSession(sessionId: string): Promise<Session>`

#### 3.2 Handle WebSocket events

- [ ] Handle `session-paused` event
  - Remove session from sidebar
  - If viewing paused session, show message and redirect
- [ ] Handle `session-resumed` event
  - Add session to sidebar
  - Update dashboard button state

### Phase 4: Frontend - UI Changes

#### 4.1 Update Session Settings Menu

- [ ] Replace "Stop Session" with "Pause" **for Worktree Sessions only**
- [ ] **Quick Sessions keep "Stop Session"** (existing behavior)
- [ ] Create `PauseSessionDialog` for Worktree Sessions
  - Update copy: "Pause" instead of "Stop"
  - Update description to explain data preservation
- [ ] Keep `EndSessionDialog` for Quick Sessions (or rename to `StopSessionDialog`)

#### 4.2 Update Dashboard (Worktree Row)

- [ ] Show "Resume" button for Paused sessions (previously showed "Restore")
- [ ] Show "Open" button for Active sessions (no change)
- [ ] Update `handleRestoreSession` → `handleResumeSession`
  - Call `resumeSession` API instead of `createSession`

#### 4.3 Handle Paused Session View

- [ ] When user is viewing a session that gets paused:
  - Show "Session Paused" overlay/message
  - Provide "Resume" button or redirect to dashboard

### Phase 5: Cleanup and Documentation

#### 5.1 Remove deprecated code

- [ ] Remove `Restore` button logic that creates new sessions for worktrees with paused sessions
- [ ] Clean up unused "Stop Session" references

#### 5.2 Update documentation

- [ ] Update CLAUDE.md if needed
- [ ] Update any user-facing documentation

### Phase 6: Testing

#### 6.1 Unit tests

- [ ] SessionManager.pauseSession tests
- [ ] SessionManager.resumeSession tests
- [ ] API endpoint tests

#### 6.2 Integration tests

- [ ] Pause → Resume flow preserves session ID
- [ ] Pause → Resume flow preserves title
- [ ] Pause → Resume flow restores workers correctly
- [ ] WebSocket events are broadcast correctly

#### 6.3 Manual testing

- [ ] Pause session via menu
- [ ] Resume session via dashboard
- [ ] Verify terminal output history is preserved
- [ ] Verify Claude conversation continues with `-c`
- [ ] Verify sidebar updates correctly
- [ ] Verify dashboard button states

## Acceptance Criteria

1. User can pause an active session via "Pause" menu item
2. Paused sessions preserve: ID, title, worker config, output files
3. User can resume a paused session via "Resume" button
4. Resumed session has same ID and title as before
5. Claude conversation continues seamlessly (with `-c` flag)
6. Terminal output history is available after resume
7. Sidebar only shows active sessions
8. Dashboard shows correct button (Open vs Resume) based on state

## Out of Scope (Future)

- **Quick Session pause support** - needs UI for displaying paused Quick Sessions
- Auto-pause idle sessions
- Memory usage visualization
- Bulk pause/resume
- Graceful shutdown with pause
