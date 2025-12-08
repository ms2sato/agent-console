# Session & Worker Implementation Plan

## Overview

This document outlines the step-by-step implementation plan for the Session & Worker architecture redesign (Issue #18).

## Phase 1: Shared Type Definitions

### Step 1.1: Add Worker Types

**File:** `packages/shared/src/types/worker.ts` (new)

```typescript
// Worker base and union types
export interface WorkerBase { ... }
export interface AgentWorker extends WorkerBase { ... }
export interface TerminalWorker extends WorkerBase { ... }
export type Worker = AgentWorker | TerminalWorker;
```

Tasks:
- [ ] Create `packages/shared/src/types/worker.ts`
- [ ] Define `WorkerBase`, `AgentWorker`, `TerminalWorker`
- [ ] Define `Worker` union type
- [ ] Export from `packages/shared/src/index.ts`

### Step 1.2: Update Session Types

**File:** `packages/shared/src/types/session.ts` (new)

```typescript
// Session base and union types
export interface SessionBase { ... }
export interface WorktreeSession extends SessionBase { ... }
export interface QuickSession extends SessionBase { ... }
export type Session = WorktreeSession | QuickSession;
```

Tasks:
- [ ] Create `packages/shared/src/types/session.ts`
- [ ] Define `SessionBase`, `WorktreeSession`, `QuickSession`
- [ ] Define `Session` union type
- [ ] Update `SessionStatus` type
- [ ] Replace old `Session` type in `index.ts`

### Step 1.3: Add API Request/Response Types

**File:** `packages/shared/src/types/api.ts` (new or update index.ts)

Tasks:
- [ ] Add `CreateSessionRequest` (union of Worktree/Quick)
- [ ] Add `CreateWorkerRequest` (union of Agent/Terminal)
- [ ] Add response types
- [ ] Update existing request types if needed

### Step 1.4: Update WebSocket Message Types

**File:** `packages/shared/src/index.ts`

Tasks:
- [ ] Rename `TerminalClientMessage` -> `WorkerClientMessage`
- [ ] Rename `TerminalServerMessage` -> `WorkerServerMessage`
- [ ] Keep old names as aliases for backward compatibility (temporary)

## Phase 2: Persistence Layer

### Step 2.1: Define Persisted Types

**File:** `packages/server/src/services/persistence-service.ts`

Tasks:
- [ ] Add `PersistedWorkerBase`, `PersistedAgentWorker`, `PersistedTerminalWorker`
- [ ] Add `PersistedWorker` union type
- [ ] Add `PersistedSessionBase`, `PersistedWorktreeSession`, `PersistedQuickSession`
- [ ] Add `PersistedSession` union type
- [ ] Remove old `PersistedSession` type

### Step 2.2: Implement Migration Logic

**File:** `packages/server/src/services/persistence-service.ts`

Tasks:
- [ ] Add `isOldFormat(session)` helper
- [ ] Add `migrateSession(oldSession)` function
- [ ] Update `loadSessions()` to detect and migrate old format
- [ ] Add migration tests

### Step 2.3: Update Persistence Methods

**File:** `packages/server/src/services/persistence-service.ts`

Tasks:
- [ ] Update `saveSessions()` to use new format
- [ ] Update `getSessionMetadata()` for new structure
- [ ] Add worker-specific helpers if needed

### Step 2.4: Write Persistence Tests

**File:** `packages/server/src/services/__tests__/persistence-service.test.ts`

Tasks:
- [ ] Test loading old format (migration)
- [ ] Test loading new format
- [ ] Test saving new format
- [ ] Test worker data within sessions

## Phase 3: Session Manager Refactoring

### Step 3.1: Define Internal Types

**File:** `packages/server/src/services/session-manager.ts`

Tasks:
- [ ] Add `InternalWorkerBase`, `InternalPtyWorkerBase`
- [ ] Add `InternalAgentWorker`, `InternalTerminalWorker`
- [ ] Add `InternalWorker` union type
- [ ] Add `InternalSessionBase`, `InternalWorktreeSession`, `InternalQuickSession`
- [ ] Add `InternalSession` union type
- [ ] Update `sessions` Map type

### Step 3.2: Implement Worker Initialization

**File:** `packages/server/src/services/session-manager.ts`

Tasks:
- [ ] Extract `initializeAgentWorker(params)` from existing code
- [ ] Add `initializeTerminalWorker(params)`
- [ ] Both should set up PTY, buffers, and event handlers

### Step 3.3: Implement Worker Lifecycle Methods

**File:** `packages/server/src/services/session-manager.ts`

Tasks:
- [ ] `createWorker(sessionId, request): Worker`
- [ ] `getWorker(sessionId, workerId): InternalWorker | undefined`
- [ ] `deleteWorker(sessionId, workerId): boolean`
- [ ] Validate worker creation (e.g., unique names within session)

### Step 3.4: Implement Worker I/O Methods

**File:** `packages/server/src/services/session-manager.ts`

Tasks:
- [ ] `attachWorkerCallbacks(sessionId, workerId, callbacks)`
- [ ] `detachWorkerCallbacks(sessionId, workerId)`
- [ ] `writeWorkerInput(sessionId, workerId, data)`
- [ ] `resizeWorker(sessionId, workerId, cols, rows)`
- [ ] `getWorkerOutputBuffer(sessionId, workerId)`
- [ ] `getWorkerActivityState(sessionId, workerId)` (agent only)

### Step 3.5: Update Session Lifecycle Methods

**File:** `packages/server/src/services/session-manager.ts`

Tasks:
- [ ] Update `createSession(request)` to handle union type
- [ ] Update to optionally create initial agent worker
- [ ] Update `getSession(id)` to return new Session type
- [ ] Update `deleteSession(id)` (renamed from `killSession`) to clean up all workers
- [ ] Update `restartSession(id)` to handle agent worker restart
- [ ] Update `getAllSessions()` return type

### Step 3.6: Update Orphan Cleanup

**File:** `packages/server/src/services/session-manager.ts`

Tasks:
- [ ] Update `cleanupOrphanProcesses()` to handle workers array
- [ ] Kill orphan worker processes, not just session processes

### Step 3.7: Remove ShellManager

**File:** `packages/server/src/services/shell-manager.ts`

Tasks:
- [ ] Verify all functionality migrated to SessionManager
- [ ] Delete file
- [ ] Remove from exports

### Step 3.8: Write Session Manager Tests

**File:** `packages/server/src/services/__tests__/session-manager.test.ts`

Tasks:
- [ ] Test WorktreeSession creation
- [ ] Test QuickSession creation
- [ ] Test worker creation (agent and terminal)
- [ ] Test worker I/O operations
- [ ] Test worker deletion
- [ ] Test session with multiple workers
- [ ] Test orphan cleanup with workers

## Phase 4: WebSocket Layer

### Step 4.1: Add New WebSocket Endpoint

**File:** `packages/server/src/websocket/routes.ts`

Tasks:
- [ ] Add `/ws/session/:sessionId/worker/:workerId` endpoint
- [ ] Implement connection handling with new SessionManager methods
- [ ] Handle history, activity state on connect

### Step 4.2: Update Message Handler

**File:** `packages/server/src/websocket/terminal-handler.ts`

Tasks:
- [ ] Rename to `worker-handler.ts`
- [ ] Update to accept `(sessionId, workerId)` parameters
- [ ] Route to correct worker in session

### Step 4.3: Remove Old Endpoints

**File:** `packages/server/src/websocket/routes.ts`

Tasks:
- [ ] Remove `/ws/terminal/:sessionId`
- [ ] Remove `/ws/terminal-new`
- [ ] Remove `/ws/shell`

### Step 4.4: Write WebSocket Tests

**File:** `packages/server/src/websocket/__tests__/routes.test.ts`

Tasks:
- [ ] Test new worker endpoint
- [ ] Test reconnection to existing worker
- [ ] Test multiple workers in same session

## Phase 5: REST API Layer

### Step 5.1: Update Session Endpoints

**File:** `packages/server/src/routes/api.ts`

Tasks:
- [ ] Update `POST /api/sessions` for new request format
- [ ] Update `GET /api/sessions` response format
- [ ] Update `GET /api/sessions/:id` to include workers
- [ ] Update `DELETE /api/sessions/:id` to clean up workers
- [ ] Update `POST /api/sessions/:id/restart` for worker handling

### Step 5.2: Add Worker Endpoints

**File:** `packages/server/src/routes/api.ts`

Tasks:
- [ ] `GET /api/sessions/:sessionId/workers` - List workers
- [ ] `POST /api/sessions/:sessionId/workers` - Create worker
- [ ] `DELETE /api/sessions/:sessionId/workers/:workerId` - Delete worker

### Step 5.3: Write API Tests

**File:** `packages/server/src/__tests__/api.test.ts`

Tasks:
- [ ] Test session CRUD with new types
- [ ] Test worker CRUD endpoints
- [ ] Test backward compatibility

## Phase 6: Client Updates

### Step 6.1: Update API Client Types

**File:** `packages/client/src/lib/api.ts`

Tasks:
- [ ] Update `Session` type usage
- [ ] Update `SessionMetadata` type
- [ ] Add `Worker` type handling
- [ ] Add `createWorker(sessionId, request)` function
- [ ] Add `deleteWorker(sessionId, workerId)` function

### Step 6.2: Update Session Page

**File:** `packages/client/src/routes/sessions/$sessionId.tsx`

Tasks:
- [ ] Fetch session with workers on mount
- [ ] Remove `useState<Tab[]>` - use session.workers instead
- [ ] Update `addShellTab` to call `createWorker` API
- [ ] Update `closeTab` to call `deleteWorker` API
- [ ] Update WebSocket URLs to new format
- [ ] Handle optimistic updates

### Step 6.3: Update Dashboard

**File:** `packages/client/src/routes/index.tsx`

Tasks:
- [ ] Update session type handling (WorktreeSession vs QuickSession)
- [ ] Update activity state handling for multi-worker sessions
- [ ] Show worker count if relevant

### Step 6.4: Update Components

Tasks:
- [ ] Update any components that depend on old Session type
- [ ] Update Terminal component if needed

## Phase 7: Testing & Cleanup

### Step 7.1: E2E Testing

Tasks:
- [ ] Test: Create WorktreeSession with agent worker
- [ ] Test: Create QuickSession with agent worker
- [ ] Test: Add terminal worker to session
- [ ] Test: Reload page - workers persist
- [ ] Test: Close worker tab
- [ ] Test: Server restart - agent worker can continue (-c)
- [ ] Test: Multiple workers in same session

### Step 7.2: Cleanup

Tasks:
- [ ] Remove deprecated type aliases
- [ ] Remove backward compatibility shims (if appropriate)
- [ ] Update documentation
- [ ] Delete old design documents

### Step 7.3: Documentation

Tasks:
- [ ] Update README if needed
- [ ] Update API documentation
- [ ] Archive or delete old design docs

## Dependency Graph

```
Phase 1 (Types)
    ↓
Phase 2 (Persistence)
    ↓
Phase 3 (Session Manager) ← Most complex
    ↓
Phase 4 (WebSocket) ←→ Phase 5 (REST API)
    ↓
Phase 6 (Client)
    ↓
Phase 7 (Testing & Cleanup)
```

## Risk Areas

1. **Migration**: Old sessions.json format needs careful handling (auto-detected and migrated)
2. **Orphan Cleanup**: Need to handle workers orphaned by server restart
3. **WebSocket Routing**: Ensuring correct worker receives I/O

## Estimated Complexity

| Phase | Files Changed | Complexity | Notes |
|-------|--------------|------------|-------|
| 1. Types | 3-4 | Low | New files mostly |
| 2. Persistence | 2 | Medium | Migration logic |
| 3. Session Manager | 2-3 | High | Core refactoring |
| 4. WebSocket | 2 | Medium | New endpoint, remove old |
| 5. REST API | 2 | Low | New endpoints |
| 6. Client | 3-4 | Medium | State management change |
| 7. Testing | - | Low | Manual + automated |

## Notes

- No backward compatibility layer needed (Closed Alpha)
- Old sessions.json format is auto-migrated on server startup
- Old WebSocket/API endpoints are removed, not deprecated
