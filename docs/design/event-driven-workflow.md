# Event-Driven Workflow Design

This document describes the design for automatically triggering Interactive Process workflows in response to inbound events (GitHub Webhooks, etc.).

> **Prerequisites**:
> - [Inbound Integration](./integration-inbound.md) — Event reception and routing
> - [Interactive Process MCP tools](#530) — `run_process` / `write_process_response` mechanism

## Motivation

The Interactive Process mechanism (#530) enables scripts to drive agent workflows via STDOUT/STDIN bridge. However, the agent must call `run_process` itself — which it may skip or forget.

This design adds **event-driven triggers** so that workflows start automatically without agent involvement. For example, when a PR's CI goes green, the acceptance-check script starts automatically against the appropriate session.

## Design Decisions

### Configuration Location: Database (not repository files)

Workflow trigger definitions are stored in the database, not in repository files (e.g., `.agent-console/workflows.yml`).

**Rationale**: Avoid coupling repository code to the Agent Console platform. Repositories should remain platform-agnostic.

### Target Resolution: `self` / `top`

Each workflow trigger specifies how to find the target session:

| Target | Resolution |
|--------|-----------|
| `self` | The session whose `worktreeId` matches the event's branch |
| `top` | Traverse the `parentSessionId` chain from `self` to the root (session with no parent) |

**Why not `hub` or `role`**: Sessions are equal — the system does not privilege any session as "orchestrator." The parent chain naturally routes events to the correct managing session without introducing a special role concept.

**Why `top` instead of `parent`**: Currently sessions are at most 2 levels deep, so `parent` and `top` are equivalent. But conceptually, the intent is "the root of the delegation chain," which remains correct even with deeper nesting.

**Fallback**: When no session matches (e.g., worktree removed), the event is logged and ignored. No automatic session creation.

### Branch Tracking: Dynamic via fs.watch (prerequisite)

Reliable target resolution depends on `worktreeId` accurately reflecting the current git branch. Currently, `worktreeId` is only updated on session restart — if a user runs `git checkout` in the worktree, it becomes stale.

**Solution**: Monitor each worktree's HEAD file via `fs.watch` and update `worktreeId` automatically when the branch changes. This is a prerequisite for event-driven workflows and independently valuable (removes need for manual branch management in UI).

See [Dynamic Branch Tracking](#dynamic-branch-tracking) section for details.

## Architecture

### How It Fits Into Existing Inbound Integration

Event-driven workflow is implemented as a new `InboundEventHandler` alongside the existing three:

```
┌──────────────────────────────────────────────────────────┐
│                    Event Handlers                         │
├──────────────┬─────────────┬──────────────┬──────────────┤
│ AgentWorker  │ DiffWorker  │ UI Notifier  │ Workflow     │
│ (PTY write)  │ (refresh)   │ (WebSocket)  │ Trigger (new)│
└──────────────┴─────────────┴──────────────┴──────────────┘
```

The `WorkflowTriggerHandler`:
1. Receives an `InboundSystemEvent` and `EventTarget`
2. Looks up matching workflow triggers for the repository and event type
3. Resolves the target session based on `target` setting (`self` or `top`)
4. Starts an Interactive Process (`run_process` equivalent) in the target session

### Data Flow

```
GitHub Webhook
    ↓
[Existing] Inbound Integration pipeline
    ↓
WorkflowTriggerHandler.handle(event, target)
    ↓
1. Query workflow_triggers WHERE repository_id AND event_type AND enabled
    ↓
2. For each matching trigger:
   a. Resolve target session (self → branch match, top → parent chain)
   b. Expand script template with event variables
   c. Start Interactive Process in target session
    ↓
Agent receives script output as [internal:process] notifications
Agent responds via write_process_response
```

### Script Template Variables

Scripts receive event context through template variables, following the same `{{VARIABLE}}` pattern used by existing hook commands (setup/cleanup):

| Variable | Source | Example |
|----------|--------|---------|
| `{{PR_NUMBER}}` | Extracted from event payload | `123` |
| `{{BRANCH}}` | `event.metadata.branch` | `feat/new-feature` |
| `{{REPO}}` | `event.metadata.repositoryName` | `owner/repo` |
| `{{COMMIT_SHA}}` | `event.metadata.commitSha` | `abc1234` |
| `{{EVENT_URL}}` | `event.metadata.url` | `https://github.com/...` |

Example trigger script:
```
node .agent-console/workflows/acceptance-check.js {{PR_NUMBER}}
```

## Database Schema

### `workflow_triggers` Table

```typescript
export interface WorkflowTriggersTable {
  /** Primary key - UUID */
  id: string;
  /** Reference to repositories.id */
  repository_id: string;
  /** Inbound event type (e.g., 'ci:completed', 'pr:merged') */
  event_type: string;
  /** Command template with {{VARIABLE}} placeholders */
  script: string;
  /** Target resolution strategy: 'self' | 'top' */
  target: string;
  /** Whether this trigger is active */
  enabled: number;  // SQLite boolean: 0 or 1
  /** ISO 8601 timestamps */
  created_at: string;
  updated_at: string;
}
```

```sql
CREATE TABLE workflow_triggers (
  id            TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  script        TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT 'top',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_workflow_triggers_repository
  ON workflow_triggers (repository_id);
```

**Design notes**:
- One repository can have multiple triggers (1:N)
- Same event type can have multiple triggers (different scripts)
- `enabled` allows temporary deactivation without deletion
- No foreign key constraint on `repository_id` (consistent with existing schema style)

### Worker Targeting

When starting the Interactive Process, the handler must choose which worker in the target session receives the output. Strategy: target the first `agent` type worker in the session (same heuristic as `AgentWorkerHandler`).

## UI

Workflow triggers are managed in the repository settings page, as a new **Workflow Triggers** section (similar to the existing Slack Notifications section). If the section becomes too crowded, it can be extracted to a linked sub-page.

The UI provides CRUD for trigger definitions:
- Event type (dropdown of `InboundEventType` values)
- Script command (text input with template variable documentation)
- Target (`self` / `top` radio or select)
- Enabled toggle

## Dynamic Branch Tracking

### Problem

`worktreeId` is set at session creation and only updated on session restart. If the git branch changes (via `git checkout`, `git switch`, etc.), `worktreeId` becomes stale, causing inbound event routing to miss the session.

### Solution

Monitor each worktree's git HEAD reference file using `fs.watch`:

- **Main repository**: `.git/HEAD`
- **Worktree**: `.git/worktrees/<name>/HEAD`

When the file changes:
1. Read the new branch name (`ref: refs/heads/<branch>` or detached HEAD)
2. Compare with current `worktreeId`
3. If different, update `worktreeId` in memory and database
4. Broadcast session update to connected clients via WebSocket

### Lifecycle

- **Start watching**: When a session is created or restored on server startup
- **Stop watching**: When a session is closed or worktree is removed
- **Server restart**: Re-establish watchers for all active worktree sessions

### Platform Considerations

`fs.watch` behavior varies across platforms. On macOS (FSEvents) and Linux (inotify), it reliably detects file writes. The HEAD file is small and written atomically by git, making it a reliable watch target.

Fallback: If `fs.watch` proves unreliable on a platform, a periodic polling check (e.g., every 30 seconds) can supplement it.

## Implementation Plan

### Phase 1: Dynamic Branch Tracking (independent value)

New Issue — prerequisite for Phase 2 but independently useful.

1. Implement HEAD file watcher service
2. Integrate with session lifecycle (start/stop watching)
3. Update `worktreeId` on branch change
4. Broadcast session updates to clients
5. Remove manual branch rename requirement from UI

### Phase 2: Workflow Trigger Infrastructure (#529)

Core event-driven workflow mechanism.

1. Database migration: `workflow_triggers` table
2. Repository layer: `WorkflowTriggerRepository` (CRUD)
3. `WorkflowTriggerHandler` implementing `InboundEventHandler`
4. Target resolution: `self` and `top` strategies
5. Script template variable expansion
6. REST API endpoints for trigger management
7. UI: Workflow Triggers section in repository settings

### Phase 3: Built-in Workflow Scripts (optional, future)

Concrete workflow scripts that leverage the trigger infrastructure:
- `acceptance-check.js` auto-triggered on `ci:completed`
- `post-merge.js` auto-triggered on `pr:merged`

These already exist as manually-invoked scripts; Phase 3 wires them to automatic triggers.

## Related

- [Inbound Integration](./integration-inbound.md) — Event reception pipeline
- [System Events](./system-events.md) — Event type definitions
- #529 — Original issue
- #530 — Interactive Process MCP tools (prerequisite, completed)
