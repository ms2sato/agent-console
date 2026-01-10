# Async Worktree Creation UI

## Overview
Convert worktree creation to an async process and show progress/error status in the left sidebar.

## Requirements
1. After clicking "Create", return to Dashboard immediately (non-blocking)
2. Show "Creating..." indicator in the left sidebar
3. On error, display error state in sidebar
4. Click sidebar item to navigate to detail page

## Design Decisions

### Client-Side Task Management

Adopted lightweight approach: manage tasks on client side.

Reasons:
- Minimize server-side changes
- Maintain existing API endpoint structure
- Simple implementation meets requirements

Trade-offs:
- Task info is lost when browser is closed
- Not synced across multiple tabs/clients (acceptable)

### WebSocket Messages
Only two messages added for completion and failure:
- `worktree-creation-completed` - On creation success
- `worktree-creation-failed` - On creation failure

---

## Implementation Plan

### Phase 1: Shared Types (packages/shared)

**File: `packages/shared/src/types/worktree-creation.ts`** (new)
```typescript
import type { CreateWorktreeRequest, Worktree } from './worktree.js';
import type { Session } from './session.js';

export type WorktreeCreationStatus = 'creating' | 'completed' | 'failed';

// Task info managed on client side
export interface WorktreeCreationTask {
  id: string;                      // Client-generated UUID
  repositoryId: string;
  repositoryName: string;
  status: WorktreeCreationStatus;
  request: CreateWorktreeRequest;  // Kept for retry
  // On completion
  sessionId?: string;
  sessionTitle?: string;
  // On failure
  error?: string;
  // Timestamp
  createdAt: string;
}

// WebSocket message payloads
export interface WorktreeCreationCompletedPayload {
  taskId: string;
  worktree: Worktree;
  session: Session | null;
  branchNameFallback?: { original: string; actual: string; reason: string };
}

export interface WorktreeCreationFailedPayload {
  taskId: string;
  error: string;
}
```

**File: `packages/shared/src/types/session.ts`** (modified)
- Add to `APP_SERVER_MESSAGE_TYPES`:
  - `'worktree-creation-completed': 14`
  - `'worktree-creation-failed': 15`
- Add to `AppServerMessage`:
  - `{ type: 'worktree-creation-completed'; ... }`
  - `{ type: 'worktree-creation-failed'; taskId: string; error: string }`

### Phase 2: Backend (packages/server)

**File: `packages/server/src/routes/api.ts`** (modified)
- Modify `POST /repositories/:id/worktrees`:
  - Add `taskId` to request (client-generated)
  - Return `{ accepted: true }` immediately
  - Process in background, notify via WebSocket on completion/failure

**File: `packages/server/src/websocket/routes.ts`** (modified)
- On success: broadcast `worktree-creation-completed`
- On failure: broadcast `worktree-creation-failed`

### Phase 3: Frontend State (packages/client)

**File: `packages/client/src/lib/api.ts`** (modified)
- Add `taskId` to `createWorktree()` request
- Change response type to `{ accepted: true }`

**File: `packages/client/src/hooks/useAppWs.ts`** (modified)
- Add new event handlers to `useAppWsEvent`:
  - `onWorktreeCreationCompleted`
  - `onWorktreeCreationFailed`

**File: `packages/client/src/hooks/useWorktreeCreationTasks.ts`** (new)
- `useWorktreeCreationTasks()` hook
  - Manage tasks in local state
  - `addTask()` - Add task (on form submit)
  - `removeTask()` - Remove task
  - `updateTaskStatus()` - Update status
  - Detect completion/failure via WebSocket events and update state

### Phase 4: UI Components (packages/client)

**File: `packages/client/src/components/sidebar/ActiveSessionsSidebar.tsx`** (modified)
- Add `creationTasks: WorktreeCreationTask[]` to props
- Add task list section above session list
- `WorktreeCreationTaskItem` component:
  - creating: spinner + "Creating..."
  - completed: green indicator + "New: {title}"
  - failed: red indicator + error icon
  - Click navigates to `/worktree-creation-tasks/$taskId`

**File: `packages/client/src/routes/worktree-creation-tasks/$taskId.tsx`** (new)
- Task detail page
- Display content:
  - Repository name
  - Status (with visual indicator)
  - Creation parameters (branch mode, prompt, etc.)
  - Error details (on failure)
  - Retry button (on failure)
  - Cancel/Delete button

**File: `packages/client/src/routes/index.tsx`** (modified)
- Use `useWorktreeCreationTasks` hook
- On form submit: add task → call API → close modal
- Pass `creationTasks` to sidebar

### Phase 5: Form Integration (packages/client)

**File: `packages/client/src/components/worktrees/CreateWorktreeForm.tsx`** (modified)
- Remove FormOverlay with `isPending` (not needed for async)
- Submit button always enabled (rate limiting handled separately)

---

## File Change Summary

| File | Action |
|------|--------|
| `packages/shared/src/types/worktree-creation.ts` | New |
| `packages/shared/src/types/session.ts` | Modified |
| `packages/shared/src/index.ts` | Modified (add export) |
| `packages/server/src/routes/api.ts` | Modified |
| `packages/server/src/websocket/routes.ts` | Modified |
| `packages/client/src/lib/api.ts` | Modified |
| `packages/client/src/hooks/useAppWs.ts` | Modified |
| `packages/client/src/hooks/useWorktreeCreationTasks.ts` | New |
| `packages/client/src/components/sidebar/ActiveSessionsSidebar.tsx` | Modified |
| `packages/client/src/routes/worktree-creation-tasks/$taskId.tsx` | New |
| `packages/client/src/routes/index.tsx` | Modified |
| `packages/client/src/components/worktrees/CreateWorktreeForm.tsx` | Modified |

---

## Sequence Diagram

```text
User          Client                    Server                  WebSocket
 |              |                          |                        |
 |--[Create]--->|                          |                        |
 |              |--[Add local task]------->|                        |
 |              |--[POST /worktrees]------>|                        |
 |              |<--[{ accepted: true }]---|                        |
 |              |--[Close modal]           |                        |
 |<--[Show task in sidebar]                |                        |
 |              |                          |--[Create worktree]---->|
 |              |                          |--[Create session]----->|
 |              |                          |                        |
 |              |<--[worktree-creation-completed]-------------------|
 |              |--[Update task to completed, show "New" badge]     |
 |<--[Sidebar updated]                     |                        |
 |              |                          |                        |
 |--[Click task]|                          |                        |
 |              |--[Navigate to session]-->|                        |
 |              |--[Remove task from list] |                        |
```

---

## Verification

1. **Unit Tests**
   - `useWorktreeCreationTasks` hook tests
   - WebSocket message handling tests

2. **Manual Testing**
   - Create worktree → Task appears in sidebar
   - Creation completes → Task shows "New: {title}", session ready
   - Click completed task → Navigate to session, task removed
   - Creation fails → Task shows error state
   - Click error task → Detail page shows error, retry available
   - Browser reload → In-progress tasks are lost (acceptable)
