# Session Initial Prompt and Title

## Background

When creating a worktree, users can specify an initial prompt that serves two purposes:
1. Generate a branch name automatically
2. Send as the first message to the AI agent

Currently, the initial prompt is only available in "From initial prompt" branch creation mode and is not stored in the session. This limits usability:
- Cannot use initial prompt with custom or existing branches
- No way to identify what the session is about after creation
- Cannot add titles to sessions for better organization

## Goals

- Allow initial prompt input for all branch creation modes
- Store initial prompt in session for reference
- Add session title for better organization
- Generate both branch name and title from a single AI call (cost efficiency)
- Allow editing title after session creation

## Design Decisions

### Session Metadata Fields

Add two new optional fields to Session:

```typescript
interface SessionBase {
  id: string;
  locationPath: string;
  status: SessionStatus;
  createdAt: string;
  workers: Worker[];
  initialPrompt?: string;  // New: the prompt used to start the session
  title?: string;          // New: human-readable title for the session
}
```

### Initial Prompt Behavior

| Prompt | Title Input | Branch Mode | Result |
|--------|-------------|-------------|--------|
| Yes | Empty | Generate | Branch + Title auto-generated |
| Yes | Empty | Custom/Existing | Title auto-generated |
| Yes | Provided | Any | Title = user input |
| No | Empty | Custom/Existing | No title |
| No | Provided | Custom/Existing | Title = user input |

Key rule: **If prompt exists and title is empty, title is always auto-generated.**

### Module Rename: session-metadata-suggester

Rename `branch-name-suggester.ts` to `session-metadata-suggester.ts` since it now handles more than branch names:

```typescript
// Before
interface BranchNameSuggestion {
  branch?: string;
  error?: string;
}

// After
interface SessionMetadataSuggestion {
  branch?: string;
  title?: string;
  error?: string;
}
```

The AI prompt will be updated to generate both branch name and title in a single call.

### Create Worktree Dialog UI

```
┌─────────────────────────────────────────────────┐
│ Create Worktree                                 │
├─────────────────────────────────────────────────┤
│ Initial prompt (optional)                       │
│ ┌─────────────────────────────────────────────┐ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ Title (optional)                                │
│ [____________________________________]          │
│ └─ Leave empty to generate from prompt          │ ← Only shown when prompt has content
│                                                 │
│ Branch name:                                    │
│ ○ Generate from prompt (recommended)            │ ← Disabled when prompt is empty
│ ○ Custom: [________________]                    │
│ ○ Existing branch: [________________]           │
│                                                 │
│ Base branch: [main________]                     │
│ Agent: [Claude Code ▼]                          │
│                                                 │
│            [Cancel]  [Create & Start Session]   │
└─────────────────────────────────────────────────┘
```

### Title Display

Title is displayed in the following locations:

**1. Session page header**

```
┌─────────────────────────────────────────────────────────────┐
│ Add dark mode toggle to settings                    [⚙️]    │
├─────────────────────────────────────────────────────────────┤
│                        (Terminal)                           │
├─────────────────────────────────────────────────────────────┤
│ feat/add-dark-mode-toggle • /path/to/worktree    (status)   │  ← Existing footer
└─────────────────────────────────────────────────────────────┘
```

- If title is empty: Header shows nothing (branch is visible in footer/status bar)
- No fallback to branch name needed

**2. Browser tab title**

```
Add dark mode toggle - Agent Console
```

- If title is empty: Use branch name as fallback
- Format: `{title || branch} - Agent Console`

### Edit Session Dialog UI

Extend the existing session settings dialog (rename from "Rename Branch" to "Edit Session"):

```
┌─────────────────────────────────────────────────┐
│ Edit Session                                    │
├─────────────────────────────────────────────────┤
│ Title                                           │
│ [Add dark mode toggle to settings_______]       │
│                                                 │
│ Branch name                                     │
│ [feat/add-dark-mode-toggle______________]       │
│                                                 │
│                        [Cancel]  [Save]         │
└─────────────────────────────────────────────────┘
```

### Edit Session Save Sequence

**Important**: The client determines whether a restart is needed BEFORE calling the API to prevent inconsistent state.

#### Case 1: Title only changed

```
User → Edit title → [Save]
         ↓
Client → Detect: branch unchanged
         ↓
Client → PATCH /sessions/:id { title }
         ↓
Server → Update title in memory and persistence
         ↓
Response { success: true, title }
         ↓
Client → Update UI, close dialog
```

#### Case 2: Branch name changed (with or without title)

```
User → Edit branch (and optionally title) → [Save]
         ↓
Client → Detect: branch changed
         ↓
Client → Show confirmation dialog:
         ┌─────────────────────────────────────────────────┐
         │ Restart Required                                │
         ├─────────────────────────────────────────────────┤
         │ Branch name change requires restarting the      │
         │ agent. Do you want to continue?                 │
         │                                                 │
         │                   [Cancel]  [Restart & Save]    │
         └─────────────────────────────────────────────────┘
         ↓
User → [Cancel] → Close confirmation, return to edit dialog (nothing saved)
User → [Restart & Save]
         ↓
Client → PATCH /sessions/:id { title, branch }
         ↓
Server → Update title + git branch -m + Restart agent worker automatically
         ↓
Response { success: true, title, branch }
         ↓
Client → onBranchChange() + onSessionRestart() → Update UI, close dialog
```

**Key Design Decision**: When `branch` is included in the request, the server automatically restarts the agent worker. This ensures atomicity - the branch rename and restart always happen together, preventing inconsistent state.

### API Changes

Consolidate into a single session metadata update endpoint:

```
PATCH /sessions/:id
Body: {
  title?: string;
  branch?: string;
}
Response: {
  success: true;
  title?: string;   // Returned if title was updated
  branch?: string;  // Returned if branch was updated
}
```

This replaces the existing `PATCH /sessions/:id/branch` endpoint.

**Server behavior**:
- If only `title` is provided: Update title only (no restart)
- If `branch` is provided: Update branch via `git branch -m`, then restart agent worker

## Changes Required

| Package | Changes |
|---------|---------|
| `packages/shared` | Add `initialPrompt` and `title` to `SessionBase`, `CreateSessionRequest` |
| `packages/server` | Rename suggester module, update AI prompt, consolidate API endpoint, store/return new fields |
| `packages/client` | Update Create Worktree dialog, refactor Edit Session dialog, update API client |

## Pre-Implementation Refactoring

Before implementing the main feature, perform these refactoring tasks:

1. **Rename suggester module**
   - `branch-name-suggester.ts` → `session-metadata-suggester.ts`
   - `suggestBranchName()` → `suggestSessionMetadata()`
   - Update all imports in `api.ts`

2. **Update suggestion type**
   - `BranchNameSuggestion` → `SessionMetadataSuggestion`
   - Add `title?: string` field

3. **Consolidate API endpoint**
   - `PATCH /sessions/:id/branch` → `PATCH /sessions/:id`
   - Update request body: `{ newBranch: string }` → `{ branch?: string, title?: string }`
   - Move restart logic into the endpoint (when `branch` is provided)
   - Update client API function: `renameSessionBranch()` → `updateSessionMetadata()`

## Implementation Tasks

### Phase 1: Refactoring (separate commits)

1. Rename `branch-name-suggester.ts` to `session-metadata-suggester.ts`
2. Update function and type names
3. Consolidate `PATCH /sessions/:id/branch` → `PATCH /sessions/:id`
4. Update client API and SessionSettings component

### Phase 2: Type Changes

5. Add `initialPrompt` and `title` to `SessionBase` in shared types
6. Add fields to `PersistedSessionBase` in persistence service
7. Add fields to `InternalSessionBase` in session manager

### Phase 3: Backend Implementation

8. Update `createSession()` to store `initialPrompt` and `title`
9. Update `toPublicSession()` to return new fields
10. Update `toPersistedSession()` to persist new fields
11. Update AI prompt to generate both branch and title
12. Add title update support to `PATCH /sessions/:id`

### Phase 4: Frontend Implementation

13. Update Create Worktree dialog UI (add title field, reorder)
14. Update request payload to include `initialPrompt` and `title`
15. Extend Edit Session dialog with title field
16. Implement client-side branch change detection and confirmation flow

### Phase 5: Testing

17. Add/update unit tests for suggester
18. Add/update tests for session manager
19. Update SessionSettings tests
20. Manual testing via browser

## Future Considerations

- GitHub Issue URL input that auto-fills title from issue title
- Session search/filter by title
- Title display in session list on dashboard
