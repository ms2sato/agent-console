# DiffViewer: GitHub-style Expand Context Lines

Issue: [#239](https://github.com/ms2sato/agent-console/issues/239)

## Overview

Add expand buttons between hunks and at file boundaries to reveal additional context lines on demand, fetching file content from the server via WebSocket.

## Implementation Steps

### Step 1: Shared types (`packages/shared/src/types/git-diff.ts`)

Add new message types to existing discriminated unions:

- **Client → Server**: `get-file-lines` with `path`, `startLine`, `endLine`, `ref` (GitDiffTarget)
- **Server → Client**: `file-lines` with `path`, `startLine`, `lines: string[]`
- Add `file-lines` to `GIT_DIFF_SERVER_MESSAGE_TYPES` runtime validation object

### Step 2: Server handler (`packages/server/src/websocket/git-diff-handler.ts`)

Add `get-file-lines` case to the `switch` in `handleMessage()`:
- For `working-dir`: read file from filesystem
- For commit ref: use `git show <ref>:<path>` via existing git helper
- Extract requested line range, return as `file-lines` message
- Validate path to prevent path traversal
- Add the `getFileLines` implementation to `git-diff-service.ts` as an injected dependency

### Step 3: Client WebSocket layer (`packages/client/src/lib/worker-websocket.ts`)

- Add `file-lines` to `isValidGitDiffMessage()` validation
- Handle `file-lines` in `handleGitDiffMessage()` — store in connection state as `expandedLines: Map<string, { startLine: number, lines: string[] }[]>` keyed by file path
- Add `requestFileLines()` convenience method
- Clear `expandedLines` when `diff-data` is received (new diff replaces old expansions)

### Step 4: Hook changes (`packages/client/src/hooks/useGitDiffWorker.ts`)

- Expose `expandedLines` and `requestFileLines(path, startLine, endLine)` from hook
- `requestFileLines` derives `ref` from current `diffData.summary.targetRef`

### Step 5: DiffViewer UI (`packages/client/src/components/workers/DiffViewer.tsx`)

- Add `expandedLines` and `onRequestExpand` props
- **Between hunks**: Calculate gap size from `hunk[n-1].oldStart + hunk[n-1].oldLines` to `hunk[n].oldStart`. Show expand button if gap > 0
- **Top of file**: If first hunk `oldStart > 1`, show expand button for lines 1..oldStart-1
- **Bottom of file**: Skip for now (requires knowing total line count)
- **ExpandButton component**: Shows "Show N more lines" (max 20 per click), calls `onRequestExpand`
- **Render expanded lines**: Insert fetched context lines with syntax highlighting, both line number columns showing same number, before the hunk they precede
- Expand count per click: 20 lines (GitHub standard)

### Step 6: GitDiffWorkerView integration (`packages/client/src/components/workers/GitDiffWorkerView.tsx`)

- Pass `expandedLines` and `requestFileLines` from hook to DiffViewer

### Step 7: Tests

- **Server**: Test `getFileLines` for working-dir and commit ref, path validation, line range bounds
- **Client**: Test expand button rendering, gap calculation, expanded lines merging

## Key Design Decisions

1. **Expanded lines stored in WebSocket connection state** (not component state) — survives tab switches
2. **Cleared on diff refresh** — when new `diff-data` arrives, old expansions are invalidated
3. **No bottom-of-file expand initially** — requires total line count which isn't available without extra server call
4. **20 lines per expand click** — matches GitHub behavior
5. **Single direction expand** — start with "expand downward from top of gap" only; bidirectional expand can be added later

## Files to Modify

| File | Change |
| ------ | -------- |
| `packages/shared/src/types/git-diff.ts` | New message types |
| `packages/server/src/services/git-diff-service.ts` | `getFileLines()` function |
| `packages/server/src/websocket/git-diff-handler.ts` | Handle `get-file-lines` message |
| `packages/client/src/lib/worker-websocket.ts` | Handle `file-lines`, store expanded state |
| `packages/client/src/hooks/useGitDiffWorker.ts` | Expose expanded lines + request method |
| `packages/client/src/components/workers/DiffViewer.tsx` | Expand buttons + render expanded lines |
| `packages/client/src/components/workers/GitDiffWorkerView.tsx` | Wire props |

## Verification

1. `bun run typecheck` — no type errors
2. `bun run test` — all tests pass (including new tests)
3. Manual test via browser: open a diff view, verify expand buttons appear between hunks, click to expand, verify lines appear with correct numbering and syntax highlighting
