# Git Diff Worker

## Background

When working with AI coding agents, developers face two key challenges:

**1. Real-time monitoring during AI coding**

AI agents write code extremely fast. Users struggle to visually track what files are being created or modified in real-time. By the time the agent finishes, dozens of files may have changed without the user noticing problematic patterns (e.g., wrong directory, unnecessary files, incorrect approach). Early detection allows immediate feedback to the agent.

**2. Post-completion review**

After the agent finishes, users need to review all changes before committing. Currently, they must:
1. Switch to a separate terminal
2. Run `git diff` manually
3. Parse ANSI-colored output in their terminal

This workflow interrupts the development flow and lacks rich visualization that modern code review tools provide.

## Goals

- **Real-time visibility**: Auto-update diff display when files change, enabling users to monitor AI agent activity as it happens
- Display git diff (PR-equivalent: from branch base to HEAD + working directory changes) within Agent Console
- Provide GitHub-like diff visualization with file list and inline diff view
- Show staged/unstaged status for each file
- Prepare for future enhancements: syntax highlighting, comments for AI feedback

## Design Decisions

### Worker Type

Git diff functionality is implemented as a new Worker type rather than a separate concept:

```typescript
type Worker = AgentWorker | TerminalWorker | GitDiffWorker;
```

**Rationale:**
- Worker is an abstraction for "functional units within a session"
- PTY presence is an internal implementation detail
- Reuses existing UI (tabs) and WebSocket infrastructure
- UX: Users perceive it as "another application running in the session"

### GitDiffWorker Definition

```typescript
interface GitDiffWorker extends WorkerBase {
  type: 'git-diff';
  baseCommit: string;  // Comparison base commit hash
}
```

- `baseCommit` is calculated at worker creation via `git merge-base <defaultBranch> HEAD`
- This captures the branch divergence point, showing PR-equivalent diff
- **Optional**: `baseCommit` can be updated later (e.g., to latest `main`) via WebSocket message

### Internal Implementation

Unlike PTY-based workers, GitDiffWorker uses:
- **File watching** (chokidar) instead of PTY
- **Transient git command execution** via `packages/server/src/lib/git.ts` (Bun.spawn, non-blocking)
- **Event-driven updates** via WebSocket

```
Bun Server Process
    │
    ├── chokidar (event listener, in-process)
    │       ↓ OS API
    │   [FSEvents / inotify]
    │
    └── lib/git.ts (Bun.spawn, async)
            └── git commands (transient child processes)
                    └── Exit immediately after completion
```

### Diff Calculation

**Worker creation (once):**
```bash
# Calculate and store baseCommit
baseCommit=$(git merge-base <defaultBranch> HEAD)
```

**Diff retrieval (on each update):**
```bash
# Get diff from stored baseCommit
git diff $baseCommit
```

This shows all changes since the branch divergence point, matching what a GitHub PR would display.

### Data Flow

```
[File Change] → chokidar detects
      ↓
[git diff / git status execution] (transient process)
      ↓
[WebSocket: send raw diff text]
      ↓
[Frontend: parse with 'diff' package → render UI]
```

### Frontend Architecture (difit-style)

Use lightweight libraries instead of all-in-one solutions:

| Purpose | Library | Size |
|---------|---------|------|
| Diff parsing | `diff` | ~15KB |
| Syntax highlight | `prismjs` + `prism-react-renderer` | ~30KB + languages (Phase 2) |
| File watching | `chokidar` (server-side) | - |

**Rationale:**
- Smaller bundle size (~50KB vs ~500KB for diff2html)
- Full UI customization (important for future comment feature)
- Follows difit's proven approach

### Git Data Types

```typescript
// packages/shared/src/types/git-diff.ts

/** File change status */
type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked';

/** Stage state for display */
type GitStageState =
  | 'committed'    // Already committed (after merge-base)
  | 'staged'       // Staged but not committed
  | 'unstaged'     // Working directory only
  | 'partial';     // Partially staged

/** Changed file info */
interface GitDiffFile {
  path: string;
  status: GitFileStatus;
  stageState: GitStageState;
  oldPath?: string;          // For renamed/copied
  additions: number;
  deletions: number;
  isBinary: boolean;
}

/** Diff hunk */
interface GitDiffHunk {
  header: string;            // e.g., @@ -1,5 +1,7 @@
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

/** Diff line */
interface GitDiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/** Diff summary (sent via WebSocket) */
interface GitDiffSummary {
  baseCommit: string;        // Comparison base commit hash
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  updatedAt: string;         // ISO 8601
}

/** Full diff data (for rendering) */
interface GitDiffData {
  summary: GitDiffSummary;
  rawDiff: string;           // Raw unified diff text
}
```

### WebSocket Messages

```typescript
// Server → Client
type GitDiffServerMessage =
  | { type: 'diff-data'; data: GitDiffData }
  | { type: 'diff-error'; error: string };

// Client → Server
type GitDiffClientMessage =
  | { type: 'refresh' }                                  // Manual refresh
  | { type: 'set-base-commit'; ref: string };            // Change base (commit hash or branch name)
```

### REST API

```
GET /sessions/:sessionId/workers/:workerId/diff
  → GitDiffData

GET /sessions/:sessionId/workers/:workerId/diff/file?path=<encodedPath>
  → { hunks: GitDiffHunk[], rawDiff: string }
```

### UI Design

```
┌─────────────────────────────────────────────────────────────────┐
│  Git Diff: main...HEAD                    [↻ Refresh] [⚙ Base] │
│  +123 additions  -45 deletions  |  5 files changed             │
├─────────────────────┬───────────────────────────────────────────┤
│ Files               │ src/services/session-manager.ts          │
│                     │─────────────────────────────────────────────
│ ▼ src/              │ @@ -42,6 +42,10 @@ export class ...       │
│   [M] session-mgr.ts│  42 │  42 │   import { Worker } from    │
│   [M*] api.ts       │  43 │  43 │   import { Session } from   │
│ ▼ packages/shared/  │     │  44 │ + import { GitDiff } from   │
│   [A*] git-diff.ts  │     │  45 │ + import { watch } from     │
│   [M] worker.ts     │  44 │  46 │                             │
│                     │  45 │  47 │   export class SessionMgr { │
└─────────────────────┴───────────────────────────────────────────┘

Legend: [M] Modified (committed)  [M*] Modified (staged)
        [A*] Added (staged)       [?] Unstaged only
```

### File List Icons

| Icon | Meaning |
|------|---------|
| `[A]` | Added (committed) |
| `[A*]` | Added (staged) |
| `[M]` | Modified (committed) |
| `[M*]` | Modified (staged) |
| `[D]` | Deleted (committed) |
| `[D*]` | Deleted (staged) |
| `[R]` | Renamed |
| `[?]` | Unstaged only |

## Persistence

### Current Structure (before)

```typescript
// packages/server/src/services/persistence-service.ts

interface PersistedWorkerBase {
  id: string;
  name: string;
  pid: number;        // PTY process ID
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
```

### New Structure (after)

Move `pid` out of base interface since GitDiffWorker has no process:

```typescript
interface PersistedWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

interface PersistedAgentWorker extends PersistedWorkerBase {
  type: 'agent';
  agentId: string;
  pid: number;        // PTY process ID
}

interface PersistedTerminalWorker extends PersistedWorkerBase {
  type: 'terminal';
  pid: number;        // PTY process ID
}

interface PersistedGitDiffWorker extends PersistedWorkerBase {
  type: 'git-diff';
  baseCommit: string; // Comparison base commit hash
  // No pid - runs in server process
}

type PersistedWorker =
  | PersistedAgentWorker
  | PersistedTerminalWorker
  | PersistedGitDiffWorker;
```

### Example `sessions.json`

```json
{
  "id": "session-abc123",
  "type": "worktree",
  "locationPath": "/path/to/worktree",
  "repositoryId": "repo-xyz",
  "worktreeId": "feat/my-feature",
  "serverPid": 12345,
  "createdAt": "2025-01-15T10:00:00.000Z",
  "title": "My feature",
  "workers": [
    {
      "id": "worker-1",
      "type": "agent",
      "name": "Claude",
      "agentId": "claude-code-builtin",
      "pid": 12346,
      "createdAt": "2025-01-15T10:00:01.000Z"
    },
    {
      "id": "worker-2",
      "type": "git-diff",
      "name": "Git Diff",
      "baseCommit": "a1b2c3d4e5f6789012345678901234567890abcd",
      "createdAt": "2025-01-15T10:10:00.000Z"
    }
  ]
}
```

## Changes Required

| Package | Changes |
|---------|---------|
| `packages/shared` | Add `GitDiffWorker` to Worker type, add git-diff types, add WebSocket message types |
| `packages/server` | Refactor `PersistedWorkerBase` (move pid), add `GitDiffService`, extend `SessionManager` for GitDiffWorker, add WebSocket handler, add REST endpoints |
| `packages/client` | Add `diff` package, create GitDiffWorkerView components, integrate into session page |

## Implementation Tasks

### Phase 1: Type Definitions (shared)

1. Add `GitDiffWorker` to Worker type union
2. Create `packages/shared/src/types/git-diff.ts` with all git-diff related types
3. Add WebSocket message types for git-diff
4. Add Valibot schemas for `CreateGitDiffWorkerRequest`

### Phase 2: Backend - Git Utilities & GitDiffService (server)

5. Add git diff utilities to `packages/server/src/lib/git.ts`:
   - `getMergeBase(branch, cwd)`: Get merge-base commit between branch and HEAD
   - `getDiff(baseCommit, cwd)`: Get unified diff from baseCommit
   - `getDiffStats(baseCommit, cwd)`: Get diff statistics (file list with additions/deletions)
   - `getStagedFiles(cwd)`: List staged files
   - `getUnstagedFiles(cwd)`: List unstaged files

6. Create `packages/server/src/services/git-diff-service.ts`
   - Uses functions from `lib/git.ts`
   - `calculateBaseCommit(repoPath)`: Get merge-base with default branch (uses `getDefaultBranch` + `getMergeBase`)
   - `getDiffData(repoPath, baseCommit)`: Get full diff data
   - `getStageStatus(repoPath)`: Get staged/unstaged file lists
   - `startWatching(repoPath, onChange)`: Start file watching (chokidar)
   - `stopWatching(repoPath)`: Stop file watching

7. Add unit tests for git utilities and GitDiffService

### Phase 3: Backend - Persistence & Worker Integration (server)

8. Refactor `PersistedWorkerBase`: move `pid` to `PersistedAgentWorker` and `PersistedTerminalWorker`
9. Add `PersistedGitDiffWorker` type
10. Add `InternalGitDiffWorker` type to SessionManager
11. Implement `initializeGitDiffWorker()` in SessionManager
12. Implement `toPublicWorker()` and `toPersistedWorker()` conversion for GitDiffWorker
13. Add cleanup logic for file watcher on worker deletion

### Phase 4: Backend - API & WebSocket (server)

14. Add REST endpoint: `GET /sessions/:id/workers/:id/diff`
15. Add REST endpoint: `GET /sessions/:id/workers/:id/diff/file`
16. Implement WebSocket handler for GitDiffWorker
17. Add WebSocket message handling for refresh/set-base-commit

### Phase 5: Frontend - Core Components (client)

18. Install `diff` package
19. Create `useGitDiffWorker` hook (WebSocket + REST integration)
20. Create `GitDiffWorkerView` container component
21. Create `DiffSummaryHeader` component (stats display)
22. Create `DiffFileList` component (file tree with stage status)
23. Create `DiffViewer` component (hunk display)
24. Create `DiffLine` component (individual line rendering)

### Phase 6: Frontend - Integration (client)

25. Add GitDiffWorker tab support in session page
26. Add "New Git Diff" button/menu option
27. Add base commit selector in GitDiffWorkerView

### Phase 7: Testing

28. Add REST API tests
29. Add WebSocket handler tests
30. Manual testing via browser

## Future Considerations

- **Syntax highlighting**: Add Prism.js integration (separate commit)
- **Mode switching**: HEAD vs working directory, specific commit comparison
- **Actions**: Stage/unstage/discard changes from UI
- **Comments → AI**: Add inline comments that can be sent to the primary agent worker
- **Diff navigation**: Keyboard shortcuts for jumping between files/hunks
