# Main Branch Pull UX Design

## Problem

When creating a new worktree, users often branch from an outdated main branch. This leads to:
- Merge conflicts when creating PRs
- Missing recent changes from other developers
- Need for rebasing before merge

The real need is not "I want to pull main" but "I want to branch from the latest main."

## Git Worktree Constraint

Git does not allow the same branch to be checked out in multiple worktrees. Since main is already checked out in worktree 0, we cannot pull main from another location.

**Solution**: Instead of pulling, we fetch and branch directly from `origin/main`.

## Solution

Integrate the fetch operation into the worktree creation flow. Check the base branch status when the form opens and offer to create from the latest remote state.

## UX Flow

### 1. Form Opens
- Fetch remote status in background (async)
- Show "Checking remote status..." while fetching
- User can start filling the form immediately

### 2. If Base Branch is Behind
- Show warning: `⚠️ X commits behind origin/main`
- Show `[Fetch & Create]` button
- User chooses:
  - **Cancel**: Close form
  - **Create**: Branch from local base branch (may be outdated)
  - **Fetch & Create**: Fetch remote, then branch from `origin/<base>` (latest)

### 3. If Base Branch is Up to Date
- No warning shown (or optional "✓ Up to date")
- Normal flow with Cancel/Create buttons

## Form Layout

```
Agent: [Claude Code ▼]              [Import from Issue]
────────────────────────────────────────────────────────
Initial prompt
  [textarea]

Title (optional)
  [input]

Branch name:
  ○ Generate from prompt (recommended)
  ○ Custom name (new branch)
  ○ Use existing branch

Branch name (if custom/existing)
  [input]

Base branch: [input] [Refresh]
⚠️ 5 commits behind                    [Fetch & Create]

                                    [Cancel]  [Create]
```

### Layout Decisions

1. **Agent selector at top-left**: Same row as "Import from Issue" for compact layout
2. **Branch settings grouped together**: Branch name mode, name input, and base branch are related
3. **Behind warning near base branch**: Contextually relevant placement
4. **Cancel/Create buttons fixed position**: Right-bottom, never moves regardless of warning state
5. **Fetch & Create appears conditionally**: Only when behind, positioned above the main action buttons

## Button Behavior

| Button | Position | Visibility | Action |
|--------|----------|------------|--------|
| Cancel | Bottom-right (fixed) | Always | Close form |
| Create | Bottom-right (fixed) | Always | Create from local base branch |
| Fetch & Create | Above Create | Only when behind | Fetch remote, create from `origin/<base>` |

### Why Fixed Positions?

- Users who want to quickly create a worktree can always click Create in the same spot
- No accidental misclicks from buttons shifting
- Fetch & Create is an additional option, not a replacement

## Technical Implementation

### API Endpoints

```
GET  /api/repositories/:id/branches/:branch/remote-status
Response: { behind: number, ahead: number }

POST /api/repositories/:id/fetch
Response: { success: boolean, error?: string }
```

### Git Commands

```bash
# Check how far behind local is from remote
git fetch origin <branch>
git rev-list --count <branch>..origin/<branch>

# Create worktree from origin (latest)
git worktree add <path> -b <new-branch> origin/<base-branch>

# Create worktree from local (may be outdated)
git worktree add <path> -b <new-branch> <base-branch>
```

### Frontend Flow

```typescript
// In CreateWorktreeForm
const { data: remoteStatus, isLoading } = useQuery({
  queryKey: ['remote-status', repositoryId, baseBranch],
  queryFn: () => fetchRemoteStatus(repositoryId, baseBranch),
  enabled: isFormOpen,
});

// Show warning if behind > 0
// Show loading indicator while checking
// Fetch & Create passes useRemote: true to create worktree API
```

### Create Worktree API Change

Add `useRemote` option to create worktree request:

```typescript
interface CreateWorktreeRequest {
  // ... existing fields
  useRemote?: boolean;  // If true, branch from origin/<base> instead of local <base>
}
```

### Edge Cases

1. **Fetch fails (network error)**: Show error message, allow Create anyway
2. **Remote branch doesn't exist**: Fall back to local branch
3. **User changes base branch**: Re-fetch remote status for new branch

## Future Enhancements

- Show commit details (what's new in remote)
- Background periodic fetch on dashboard
- "Always use remote" user preference
