# File Viewer Worker

Status: design (Issue #2194). The implementation AC follows after this document merges. Every statement about existing code below was checked against `main` at 3168977f and names a file and a symbol, not a line number.

## Background

Today the console shows a session's working directory through terminals, the git diff worker, and agent output. There is no place to simply look at the files of the worktree (or directory) a session works in: the user opens a separate terminal or editor to read a file the agent mentioned, to check what the agent left in an untouched directory, or to read a file that is not part of the diff.

The owner asked for a general-purpose, read-only file view as a new worker type: a file tree on the left, the selected file's content with syntax highlighting on the right.

A later version (explicitly out of scope here) lets the user attach comments to file content, send them to the session's main AI agent, and show the agent's reply in the viewer. This is the same idea as the git diff worker's review annotations ([diff-review-annotations.md](diff-review-annotations.md)). v1 builds none of it but must not make it hard; see [Later: comments to the main agent](#later-comments-to-the-main-agent).

## Goals

- Browse the tree of a session's working directory and read any text file in it, with syntax highlighting.
- Work in multi-user mode, where the working directory may be mode 0700 and owned by the session owner, not the server user.
- Never show `.git` or ignored files (`.gitignore` is honoured) in v1.
- Stay bounded: a file larger than 1 MiB is truncated, a binary file shows no content.
- Be usable on a phone.
- Add no new dependency and no database migration.

Non-goals for v1: editing, search, live updates (question 1 below), non-git directories (question 2), showing ignored files (question 3), comments.

## Design Decisions

### Worker type

A new worker type `file-viewer`, non-PTY and server-process, like `git-diff` (`InternalGitDiffWorker` in `packages/server/src/services/worker-types.ts`). It has no process to kill and nothing to restore:

- `FileViewerWorkerSchema` in `packages/shared/src/schemas/worker.ts` is `WorkerBase` plus `type: 'file-viewer'`. There is no extra persisted field: the selected path and the expanded directories are client state, so a reload starts at the tree root.
- `CreateWorkerRequestSchema` gains a `CreateFileViewerWorkerParamsSchema` variant (`name` optional, `type: 'file-viewer'`, a `v.strictObject` like its siblings). The shared worker unions in `packages/shared/src/schemas/app-server-message.ts` and the `Worker` type gain the variant, so `SCHEMA_VERSION` moves once, at implementation.
- `InternalFileViewerWorker` in `worker-types.ts` extends `InternalWorkerBase` with `type: 'file-viewer'` and nothing else; it joins the `InternalWorker` union.
- Restart-all, pause, resume and session deletion treat it like `git-diff`: `RestartAllAgentWorkersResultEntry.workerType` already omits `git-diff` because such workers are in-process, and the same applies. Session deletion has a `git-diff` branch that stops the file watcher; the file viewer has no watcher in v1, so that branch is a no-op for it. The implementation walks every `worker.type === 'git-diff'` site in `session-manager.ts`, `worker-lifecycle-manager.ts`, `session-deletion-service.ts`, `session-initialization-service.ts` and `session-converter-service.ts` and decides each explicitly.
- No DB migration: the `workers.type` column has no CHECK constraint. The persisted-worker mapper and persisted-types union gain the variant.
- Glossary entry `File Viewer Worker` lands in the same PR as this document.

**Differences from `git-diff` that the implementation must not copy.** The `git-diff` worker is auto-created with every session (`SessionManager` creates a `git-diff` worker named `Diff` right after the initial worker) and is a fixed tab: `isCloseableTabType` in `packages/client/src/components/sessions/tabAppearance.ts` returns false for it. The file viewer is opt-in and user-removable, like a terminal: it is created from the add-worker menu, and `isCloseableTabType` returns true for `file-viewer`. See [UI](#ui).

### Transport: REST, lazy, no WebSocket in v1

Two read-only routes under the existing worker routes in `packages/server/src/routes/workers.ts`, next to the `/diff` and `/diff/file` routes. No WebSocket endpoint is added in v1 (live updates are open question 1).

```
GET /api/sessions/:sessionId/workers/:workerId/files/tree?path=<dir>
GET /api/sessions/:sessionId/workers/:workerId/files/content?path=<file>
```

Both routes: look up the session and worker (404 otherwise), reject a worker whose `type` is not `file-viewer` (`ValidationError`, as the diff routes do for non-`git-diff`), and validate `path` as described under [Path safety](#path-safety).

Access: `assertCanOperateSession` from `packages/server/src/lib/session-access.ts`, called as the worker route that already uses it does (the MCP-server-permission route in `routes/workers.ts`): it passes `sessionManager`'s session, `c.get('authUser')`, `sharedAccountRegistry` and `serverConfig.AUTH_MODE`. It is a no-op outside multi-user mode and allows the session owner or a shared account's sessions. **Note:** the existing `/diff` and `/diff/file` routes do not call it; reading file contents is the more sensitive operation, so the file viewer routes do, and the gap on the diff routes is not widened by this work.

### Path safety

Two layers, both required:

1. **Lexical guard.** `isValidFilePath` in `packages/server/src/services/git-diff-service.ts` rejects absolute paths, any path containing `..` (as a substring, so a file named `a..b` is also rejected -- accepted, rare), and any path containing a NUL byte. It is a module-private function today (`getFileLines`, `getFileDiff` and the other callers are in the same file), so the implementation exports it (or hoists it to `lib/`) rather than copying it. The tree route accepts the empty string as the root; the content route requires a non-empty path.
2. **Containment after symlink resolution.** The lexical guard does not stop a symlink inside the worktree that points outside it. The file viewer applies the embedded-agent confinement rule ([embedded-agent-worker.md](embedded-agent-worker.md), "Follow symlinks via `realpath`"): resolve the target with `realpath`, walking up to the nearest existing ancestor if the leaf does not exist, and accept it only if it equals `realpath(session.locationPath)` or is prefixed by it plus `path.sep`. The embedded agent's helper `resolveConfinedPath` (`packages/embedded-agent/src/tools/path-confinement.ts`) is in another package and runs in the agent subprocess; the implementation either reuses its logic through `packages/shared` or states why a server-side copy is required (a duplication check applies, per the workflow rule). In multi-user mode the `realpath` itself must run as the session owner, because the server user cannot traverse a 0700 directory; it is part of the same elevated runner call as the read (see [Content read](#content-read-as-the-session-owner)).

### Tree source: git, as the session owner

The tree is built from git, not from a directory walk:

```
git ls-files --cached --others --exclude-standard -z -- <dir>/
```

run through the existing `gitSafe(args, cwd, requestUser)` in `packages/server/src/lib/git.ts` with `cwd = session.locationPath`. This honours `.gitignore` and never lists `.git`, by construction, with no new ignore library.

Identity: the session's effective spawn user, resolved with `resolveSpawnUsername(session.createdBy, userRepository)` from `packages/server/src/services/resolve-spawn-username.ts`. That is what both the `/diff` routes and the git-diff WebSocket connection (`handleGitDiffConnection` in `packages/server/src/websocket/git-diff-handler.ts`, called from `websocket/routes.ts`) pass as `requestUser`: the OS user that owns the worktree, **not the authenticated viewer**, which matters for shared sessions. (`resolveRequestUsername`, the sibling that returns `null` instead of falling back to the server user, is the MCP-tool variant; the REST and WebSocket git-diff paths use `resolveSpawnUsername`, and the file viewer follows them. The two behave the same downstream: the elevated runner bypasses elevation when the username equals the server user.)

**One level per request.** `git ls-files` returns a flat recursive list. `--directory` does not help for a lazy level: it collapses only wholly-untracked directories into a trailing-slash entry and still lists every tracked file individually. The server therefore reduces the output itself: for the requested directory it groups paths by their first segment after the prefix, emits each segment that has a further `/` as `kind: 'dir'`, and the rest as `kind: 'file'` (an untracked directory collapsed by `--directory` becomes a `dir` entry for free, so `--directory` is still passed to avoid enumerating huge untracked trees such as an unignored build output). Cost is one git invocation per expand, proportional to the files under that directory; accepted for v1. Sorting is done on the client (directories first, then name).

**Tree entry:**

```typescript
// packages/shared/src/types/file-viewer.ts
interface FileTreeEntry {
  name: string;               // single path segment
  kind: 'dir' | 'file';
  size?: number;              // bytes, files only
}

interface FileTreeResponse {
  path: string;               // the directory that was listed ('' = root)
  entries: FileTreeEntry[];
}
```

`size` comes from the filesystem, not from git, so in multi-user mode it is read through the elevated runner too, as one batched call per listing (portable POSIX tools; no GNU-only `stat` flags, since macOS is a supported host). A file that disappeared between the git listing and the size read is returned without `size`.

A directory that is not inside a git repository yields an empty git result; see open question 2 for how that is presented.

### Content read as the session owner

**The server process must not read the file directly in multi-user mode.** The worktree may be 0700 and owned by the session owner, and the server user cannot open files in it.

A pre-existing gap of exactly this shape exists today: `getFileLines` in `git-diff-service.ts` reads the `working-dir` ref with `readFile(join(repoPath, filePath))` as the server process, and its `requestUser` parameter is documented as "Ignored on the 'working-dir' branch (direct filesystem read)". It fails on a 0700 user worktree in multi-user mode. This is tracked in #2199 and is not fixed by this work; **the file viewer must not copy it.**

Mechanism: `runAsUser` in `packages/server/src/services/privilege-elevation.ts` with `username = resolveSpawnUsername(...)`. Its `command` is passed verbatim to `sh -c`, so every path is wrapped in `shellEscape` (exported from the same module, used by its other callers) and the command ends options with `--`:

```
head -c <FILE_VIEWER_MAX_BYTES + 1> -- <escaped path>
```

`cwd` is `session.locationPath`. One extra byte is read so that "larger than the cap" is detectable without a second `stat`. The total size is obtained by a second small call in the same elevated shell (`wc -c`), so the response can say "first 1 MiB of N". When elevation is bypassed (single-user mode, `AUTH_MODE=none`, or the spawn user equals the server user), `runAsUser` runs the same command directly; the implementation may use a direct `readFile` plus a bounded slice in that branch only if a test proves both branches return the same response for the boundary values below. A test per mode is required (pre-PR completeness Q9: single-user, multi-user with the server user as owner, multi-user with another owner).

### Binary and size handling

- **Binary** = a NUL byte within the first 8 KiB of the content, git's own heuristic (`isBinary` in `packages/server/src/lib/git.ts` carries the same notion for diff files).
- **Cap** `FILE_VIEWER_MAX_BYTES = 1 MiB (1048576)` in `packages/server/src/lib/server-config.ts`, read through `serverConfig` like the other byte limits there.
- A file larger than the cap returns the first 1 MiB with `truncated: true`; the UI shows "showing the first 1 MiB of N". A binary file returns `kind: 'binary'`, its size, and no content; the UI shows a "binary file" notice.
- The truncation point may fall in the middle of a UTF-8 sequence; the server decodes with replacement characters and does not try to re-align (the user is told the view is truncated).

Boundary values (each is a test):

| Case | Result |
|---|---|
| Empty file (0 bytes) | `kind: 'text'`, `content: ''`, `size: 0`, `truncated: false` |
| Exactly 1 MiB | `kind: 'text'`, full content, `truncated: false` |
| 1 MiB + 1 byte | `kind: 'text'`, first 1 MiB, `truncated: true` |
| NUL byte at byte 8193 (just past the 8 KiB window) | `kind: 'text'` (not detected as binary; the window is the definition) |
| NUL byte within the first 8 KiB | `kind: 'binary'`, no content |
| `path` is a directory (content route) | 400 `ValidationError` |
| `path` does not exist | 404 |
| `path` resolves outside `locationPath` through a symlink | 400 / 403 `ValidationError`, never content |
| `path` is a tree-route request for a file | 400 |

### Wire shapes

```typescript
// packages/shared/src/types/file-viewer.ts (schemas in packages/shared/src/schemas/file-viewer.ts)
type FileContentKind = 'text' | 'binary' | 'too-large';

interface FileContentResponse {
  path: string;               // echoes the validated request path, stable across reloads
  kind: FileContentKind;
  content?: string;           // present for 'text' only
  size: number;               // total bytes on disk
  truncated: boolean;         // true only when kind === 'text' and the cap cut the content
  language: string;           // Prism language name, 'text' when unknown
}
```

`kind: 'too-large'` is reserved for a response where the server refuses to return even a prefix (not used by v1: v1 truncates). It is listed in the union because the AC fixes the union; the implementation may drop it if nothing produces it, since an unproduced union member is dead surface. Both responses are `v.strictObject` schemas in `packages/shared/src/schemas/`, parsed by the client, per the schema-type parallel maintenance rule (pre-PR completeness Q10); an integration test in `packages/integration/src/` exercises server-populates, serialise, schema-parse, client shape.

`language` is computed on the server from the file name so the client does not need the map for the wire, but the client owns the Prism language set (see [Highlighting](#ui)); the server value is a name from that same set or `'text'`.

## UI

### Highlighting: the existing Prism stack

`prism-react-renderer` (`Highlight`, `themes.vsDark`), with additional grammars registered by `packages/client/src/lib/prism-languages.ts` (ruby, bash, css, scss, less, typescript, javascript, sql, ...), which first imports `packages/client/src/lib/prism-setup.ts` to publish the global `Prism` instance. No new dependency.

**What the code actually does today (read from `DiffViewer.tsx`).** `packages/client/src/components/workers/DiffViewer.tsx` is **neither virtualised nor length-capped**. It renders every diff line as a DOM row; `HighlightedLine` runs one `Highlight` per line (tokenising the single line, using `tokens[0]`), and long unchanged regions are bounded only by the diff itself being a diff (context gaps expand by `MAX_EXPAND_LINES = 20` at a time). The extension-to-language map is **not** in `prism-languages.ts`: it is a private function `getLanguageFromPath` inside `DiffViewer.tsx` (extensions plus a few special file names, `'plain'` as the fallback). Unlike a diff, a file viewer renders a whole file, so copying the diff approach unchanged would render up to a million characters as thousands of per-line `Highlight` instances.

Decision for the viewer, given the 1 MiB server cap:

- The language map is hoisted from `DiffViewer.tsx` into a shared client helper (for example `packages/client/src/lib/prism-language-for-path.ts`) used by both `DiffViewer` and the viewer. The hoist is part of the implementation PR, with the fallback unified (the diff uses `'plain'`; the wire says `'text'`; the helper maps `'text'` to the Prism name `'plain'`).
- The file is tokenised **once** with a single `Highlight` over the whole content (so multi-line constructs such as block comments and template strings highlight correctly, which the per-line approach in the diff cannot do) and rendered as a windowed list: only the rows near the viewport are mounted. The implementation chooses the windowing mechanism; because no list-virtualisation library exists in the repository (checked: no match in `packages/client/package.json` or `src`), the AC requires either a small fixed-row-height windowing hook with a test, or, if the owner prefers zero new code paths, a hard render cap of 5000 lines with a "show more" control. This is an implementation choice inside the 1 MiB bound; it changes no wire shape and no surface cell.
- Tokenising 1 MiB once is bounded work; it runs when a file is selected and is memoised per `(path, content)`.

### Layout

- **Desktop:** two panes. Left: the tree (lazy expand on click of a directory, directories first then name sort, the open directories' state in component state). Right: the selected file, with line numbers, the path shown as a header, and a truncation or binary notice where applicable. A Refresh button in the tree header re-lists every open directory and re-reads the selected file.
- **Mobile:** `useIsMobile` (`packages/client/src/hooks/useIsMobile.ts`) switches layout. It is used by `SessionPage.tsx` (for the side-panel drawer), `routes/__root.tsx` and the terminal keyboard input; the worker view components do not use it today, so this is the first worker view to branch on it. The viewer follows the pattern `SessionPage` already uses for the side panels: when mobile, the tree is a toggle drawer over the content, opened by a button in the header and closed on file selection. Branch with the hook, not with `md:hidden`, for the same reason `SessionPage` documents (the hidden subtree would still mount).
- **Tab:** `packages/client/src/components/sessions/tabAppearance.ts` gains a `file-viewer` case in each exhaustive switch (`getTabDotColor`, `getWorkerTypeLabel` -> `'File Viewer'`) and returns true from `isCloseableTabType`. `SessionPage.tsx` renders an icon for `git-diff` tabs (`DiffIcon`) instead of the status dot; `file-viewer` gets its own icon in the same branch, and the active-tab switch renders a new `FileViewerWorkerView` next to `GitDiffWorkerView`.

### Creation: the add-worker menu

The add-worker control in `SessionPage.tsx` is `AddAgentWorkerMenu` (`packages/client/src/components/sessions/AddAgentWorkerMenu.tsx`, props `onSelect` / `onSelectShell`), backed by `addAgentTab` / `addTerminalTab` in `packages/client/src/components/sessions/hooks/useTabManagement.ts`, which call `createWorker` from `lib/api`. **The `git-diff` worker is not created from this menu**: it is created server-side with the session. The file viewer therefore needs a new menu item and a new callback (`onSelectFileViewer` -> `addFileViewerTab`, posting `{ type: 'file-viewer' }`), placed beside the "Shell" item, which is the other item that has no agent options. The menu's header comment ("lists a plain Shell item, terminal AgentDefinitions and EmbeddedAgentDefinitions") is updated in the same PR.

## Persistence

The `workers` row stores `id`, `session_id`, `type`, `name`, `created_at`, and nothing type-specific for `file-viewer` (the git-diff worker's `base_commit` has no counterpart). Nothing about selection or expansion is persisted. On server restart the worker is restored as a plain in-process worker with no activation work. No migration; the persisted-type union and the mappers (`toPersistedWorker`, the repository mappers) gain the variant.

## Surfaces

Decision table per [decision-table.md](../../.claude/rules/decision-table.md). Rows are operations; columns are surfaces. Every cell is `do:` or `not here:`; there is no undecided cell. The UI cells (worker tab, add-worker menu) are marked **owner confirmation pending**: the owner confirms them on the design-doc PR, and the table then records `owner-confirmed <date>`.

| Operation | Worker tab | Add-worker menu | REST | MCP `create_worker` / `delegate_to_worktree` options | Embedded-agent-visible |
|---|---|---|---|---|---|
| Create viewer | not here: a tab is the result of creating, not a way to create one. (owner confirmation pending) | do: new "File viewer" item in `AddAgentWorkerMenu` (`onSelectFileViewer` -> `addFileViewerTab` in `useTabManagement.ts`). (owner confirmation pending) | do: `POST /api/sessions/:sid/workers` with `{ type: 'file-viewer' }` (new `CreateWorkerRequestSchema` variant) | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| List tree | do: `FileViewerWorkerView` left pane (lazy expand, directories first, name sort; mobile: toggle drawer). (owner confirmation pending) | not here: the menu only creates workers. (owner confirmation pending) | do: `GET .../workers/:wid/files/tree?path=<dir>` (one directory level) | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Read file | do: `FileViewerWorkerView` right pane (highlighted, line numbers, truncation / binary notices). (owner confirmation pending) | not here: the menu only creates workers. (owner confirmation pending) | do: `GET .../workers/:wid/files/content?path=<file>` | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Refresh | do: Refresh button in the tree header (re-lists open directories, re-reads the selected file). (owner confirmation pending) | not here: the menu only creates workers. (owner confirmation pending) | not here: refresh is the client calling the two GET routes again; the server has no cache to invalidate. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Live updates (watch and push changes) | not here: later, a follow-up Issue will be filed on the owner's answer to question 1. (owner confirmation pending) | not here: the menu only creates workers. (owner confirmation pending) | not here: later, a follow-up Issue will be filed on the owner's answer to question 1. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Comment (later) | not here: later version, designed in [Later: comments to the main agent](#later-comments-to-the-main-agent); v1 builds nothing. A follow-up Issue is filed when v1 merges. (owner confirmation pending) | not here: the menu only creates workers. (owner confirmation pending) | not here: later version; v1 reserves only a stable `path` and `language` on the content response. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |

Notes on the table:

- The "Live updates" row is included because the AC's open question 1 makes it a real operation with a decided v1 answer (not built); the cell names the follow-up that the owner's answer triggers.
- MCP cells are `not here` for a reason that is the Issue's own framing. `delegate_to_worktree` and `create_worker` expose agent-selection options; a viewer has none, so a caller that wants file contents uses its own Read / Glob / Grep tools, which see the same tree. If the owner later wants a session to open a viewer for the user (for example, "open this file for me"), that is a new operation and a new row.
- The "embedded-agent-visible" column follows `AGENT_OPERATIONS` in `packages/shared/src/types/agent-operations.ts` in spirit but not in type: the file viewer is not an agent operation, so no `satisfies Record<AgentOperation, SurfaceExposure>` table is added. The decision is recorded here, in the document, where [decision-table.md](../../.claude/rules/decision-table.md) puts it.

## Later: comments to the main agent

No code in v1. This section fixes the model so v1 does not close the door.

**Model.** A comment is `{ path, startLine, endLine, body }`, anchored to a line range of a file as the viewer showed it. The user writes it in the viewer; it is delivered to the session's main agent worker; the agent's reply returns to the viewer.

**Delivery.** Through the existing `SessionManager.deliverWorkerNotification` seam (`packages/server/src/services/session-manager.ts`), the same path that inbound events, timers, conditional wakeups and todos use. The seam routes to a PTY-backed worker through `writePtyNotification` and to an embedded-agent worker through its system-notification path, and returns `{ ok: false, reason }` otherwise. A comment is therefore a notification with a rendered body such as "File comment: `src/a.ts` lines 10-12: <body>", addressed to the session's primary agent worker. The viewer worker is not itself a notification target (it is neither PTY-backed nor an embedded agent), so the predicate `canReceiveNotifications` is unchanged.

**Reply.** The agent answers by an MCP tool call (a new tool, designed then) that the server turns into a `file-viewer` worker event pushed to the viewer, the way review annotations reach the diff viewer. This is the point at which the viewer gains a live channel: a worker WebSocket for events, which is also where the live-updates follow-up from open question 1 would attach, so the two should be designed together.

**What v1 reserves:**

- A stable `path` on the content response (always the validated, repository-relative path), so a comment can name the file without re-deriving it.
- A `language` on the content response (already needed for highlighting).
- Line numbers in the rendered content that match the lines of the returned text (the truncation cuts at the end only, so line numbers of the shown prefix are the file's line numbers).
- The `file-viewer` worker type itself, so events have an address.

**What v1 does not build:** comment UI, comment persistence (no table and no column), the delivery code, the reply tool and event, anchoring that survives the file changing underneath a comment (a later design must choose between line-based anchors with a staleness check and content-hash anchors; v1 takes no position), and any WebSocket channel for the viewer.

## Open questions for the owner

Each has a recommendation (marked) and none blocks writing the implementation AC; the doc PR is where they are answered.

### 1. Live updates

**Background.** The git diff worker watches the session's `locationPath` and recomputes the diff when files change (`startWatching` in `packages/server/src/services/git-diff-service.ts`, driven from `git-diff-handler.ts`). If the file viewer rode the same watcher, the tree and the open file would follow changes as the agent writes them, but that needs a WebSocket channel for the viewer and widens the v1 implementation.

**Options.**
- (A) v1 has a Refresh button only. Live updates are a follow-up Issue.
- (B) v1 shares the watcher: the tree updates automatically, and the content updates for the open file only.

**Recommendation: (A).** The problem the owner described is "there is no place to see the files"; following changes as they happen is secondary. The follow-up Issue is named in the Surfaces table's "Live updates" cell and is filed on the owner's answer.

### 2. Directories that are not git repositories

**Background.** Taking the tree from `git ls-files` makes `.gitignore` and `.git` correct for free, but a quick session's arbitrary directory that is not under git yields an empty result.

**Options.**
- (A) v1 supports git-managed worktrees and directories only. A directory outside git shows "not a git repository".
- (B) A directory outside git is listed with an `ls`-equivalent as the session owner, with no ignore rules.

**Recommendation: (A).** The owner's example is a worktree. (B) would show `node_modules` and similar with no ignore rules, which is a different design.

### 3. Showing ignored files

**Background.** `--exclude-standard` hides everything `.gitignore` names. There are occasions to look at generated output (build artifacts, logs).

**Options.**
- (A) v1 always hides ignored files.
- (B) v1 adds a "show ignored" toggle that additionally calls `git ls-files --others --ignored --exclude-standard`.

**Recommendation: (A).** v1 is for reading source. The toggle can be added later without changing the wire shapes (a query parameter on the tree route).

## Implementation Tasks

1. Shared: `FileViewerWorkerSchema`, the `CreateWorkerRequestSchema` variant, the `Worker` / app-server-message unions, `FileTreeResponse` / `FileContentResponse` types and schemas (`v.strictObject`), `FILE_VIEWER_MAX_BYTES` documented in `server-config.ts`; regenerate `SCHEMA_VERSION` (`bun run build`).
2. Server: `InternalFileViewerWorker`, worker creation / persistence / conversion / deletion / restart-all handling at every `git-diff` site; export `isValidFilePath`; a `file-viewer-service` (tree via `gitSafe`, content via `runAsUser`, realpath containment, binary and size rules); the two routes with `assertCanOperateSession`.
3. Client: `FileViewerWorkerView` (tree + content, mobile drawer), the hoisted language helper (and `DiffViewer` switched to it), windowed rendering or a render cap, `tabAppearance.ts`, `SessionPage.tsx` icon and view branches, `AddAgentWorkerMenu` item and `addFileViewerTab`.
4. Tests: every boundary value in the table above; one test per mode (single-user, multi-user server-owned, multi-user other owner); a symlink-escape test; a wire-level integration test in `packages/integration/src/`; a `tabAppearance` exhaustiveness test; browser QA with screenshots attached to the PR, including the mobile drawer.
5. Docs: README Features entry (`(in development)` until finished), `docs/glossary.md` entry (already added with this document), `session-worker-design.md` row (already added with this document).
6. Follow-ups (filed by their owners, not by this work): `getFileLines` working-directory read as the server process (#2199); live updates (Issue filed on the owner's answer to question 1); comments (Issue filed when v1 merges).
