# Branch Rename Support

## Background

When creating a worktree, the branch name is often undecided. The current design assumes directory name equals branch name, making it difficult to rename branches later.

## Goal

- Allow starting with a temporary branch name at worktree creation
- Enable free branch renaming during a session

## Design Decisions

### Separation of Directory Name and Branch Name

- **Directory name**: Fixed at creation time (never renamed)
- **Branch name**: Can be freely changed via `git branch -m`
- **Display**: Always uses actual branch name fetched from git

Renaming directories is avoided due to risk of inconsistency with git worktree internal state.

### Default Branch Name

Auto-generate a neutral default name at worktree creation:

```
wt-001-x2sl
wt-002-a3f9
```

- Format: `wt-{index:3 digits}-{4 random alphanumeric characters}`
- User can modify or use as-is
- Users with clear intent can change to a meaningful name immediately

### Add branch to Session

```typescript
interface Session {
  id: string;
  worktreePath: string;
  repositoryId: string;
  status: SessionStatus;
  activityState?: ClaudeActivityState;
  pid?: number;
  startedAt: string;
  agentId?: string;
  branch: string;  // Added
}
```

- Fetch via `git branch --show-current` at session start
- Same logic for both Worktree and Quick Sessions
- Eliminates need for path-based branch name extraction

### Remove Worktree.head

```typescript
interface Worktree {
  path: string;
  branch: string;
  // head: string;  // Removed
  isMain: boolean;
  repositoryId: string;
  index?: number;
}
```

Reasons for removal:
- Currently unused anywhere
- Becomes stale after commits (just a snapshot at fetch time)
- Use `git merge-base` when branch point is needed

### Session Settings Dialog

Place a button (e.g., gear icon) in the top-right of the session screen. Click opens a settings dialog.

```
+-----------------------------+
| Session Settings        [x] |
+-----------------------------+
| Branch name                 |
| +-------------------------+ |
| | feature-auth            | |
| +-------------------------+ |
|                             |
| (Future: other settings)    |
|                             |
|        [Cancel]  [Save]     |
+-----------------------------+
```

- Currently only branch rename
- Generic design for future extensibility
- On Save: execute `git branch -m` + update `Session.branch`

## Changes Required

| Package | Changes |
|---------|---------|
| `packages/shared` | Add `Session.branch`, remove `Worktree.head` |
| `packages/server` | Fetch branch at session start, add branch rename API |
| `packages/client` | Generate default name, remove path extraction logic, settings dialog UI |

## Implementation Tasks

1. Remove `Worktree.head`
2. Add `Session.branch` and fetch at session start
3. Replace path extraction logic with `session.branch` / `worktree.branch` in frontend
4. Generate and display default branch name in worktree creation UI
5. Add branch rename API
6. Implement session settings dialog
