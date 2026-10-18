# File Viewer Worker

Status: implemented (PR #2214, Issue #2194), redirected by the owner on 2026-10-18 to a plain directory listing that filters nothing (see the last paragraph of Background). Live updates are implemented (PR #2221 schema, PR #2222 server, PR #2228 client): the [Live updates](#live-updates) section is the design of the follow-up Issue #2205, whose transport the owner decided on 2026-10-19 (the worker WebSocket, option (a)). Every statement about existing code below was checked against `main` at 3168977f and names a file and a symbol, not a line number.

## Background

Today the console shows a session's working directory through terminals, the git diff worker, and agent output. There is no place to simply look at the files of the worktree (or directory) a session works in: the user opens a separate terminal or editor to read a file the agent mentioned, to check what the agent left in an untouched directory, or to read a file that is not part of the diff.

The owner asked for a general-purpose, read-only file view as a new worker type: a file tree on the left, the selected file's content with syntax highlighting on the right.

A later version (explicitly out of scope here) lets the user attach comments to file content, send them to the session's main AI agent, and show the agent's reply in the viewer. This is the same idea as the git diff worker's review annotations ([diff-review-annotations.md](diff-review-annotations.md)). v1 builds none of it but must not make it hard; see [Later: comments to the main agent](#later-comments-to-the-main-agent).

Redirect, 2026-10-18: the first draft built the tree from `git ls-files` and so hid `.git` and ignored files. The owner redirected to a simple tree that filters nothing, because files such as dot-env configuration must be reachable (and are expected to become editable, see [Later: editing dot-env-class files](#later-editing-dot-env-class-files)). The tree is now a plain directory listing and works the same for git and non-git directories.

## Goals

- Browse the tree of a session's working directory and read any text file in it, with syntax highlighting.
- Work in multi-user mode, where the working directory may be mode 0700 and owned by the session owner, not the server user.
- Show every entry of the working directory, including dotfiles and `.git`; nothing is filtered (owner direction, 2026-10-18: files such as dot-env configuration must be reachable).
- Stay bounded: a file larger than 1 MiB is truncated, a binary file shows no content.
- Be usable on a phone.
- Add no new dependency and no database migration.

Non-goals for v1: editing and any other write access (see [Later: editing dot-env-class files](#later-editing-dot-env-class-files)), search, live updates (answered: Refresh only in v1, see [question 1](#1-live-updates); the follow-up is designed in [Live updates](#live-updates)), comments.

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

Two read-only routes under the existing worker routes in `packages/server/src/routes/workers.ts`, next to the `/diff` and `/diff/file` routes. No WebSocket endpoint is added in v1 (live updates: Refresh only, question 1; the follow-up #2205 is designed in [Live updates](#live-updates)). A worker WebSocket opened for a `file-viewer` worker is refused explicitly: an `error` frame with code `UNSUPPORTED_OPERATION`, then `exit`, then a normal closure (1000, which is in the client's no-reconnect set, so it does not loop); `WORKER_NOT_STREAMABLE` does not exist and adding a code would change the protocol-dispatch trigger files, so the nearest existing code is used.

```
GET /api/sessions/:sessionId/workers/:workerId/files/tree?path=<dir>
GET /api/sessions/:sessionId/workers/:workerId/files/content?path=<file>
```

Both routes: look up the session and worker (404 otherwise), reject a worker whose `type` is not `file-viewer` (`ValidationError`, as the diff routes do for non-`git-diff`), and validate `path` as described under [Path safety](#path-safety).

Access: `assertCanOperateSession` from `packages/server/src/lib/session-access.ts`, called as the worker route that already uses it does (the MCP-server-permission route in `routes/workers.ts`): it passes `sessionManager`'s session, `c.get('authUser')`, `sharedAccountRegistry` and `serverConfig.AUTH_MODE`. It is a no-op outside multi-user mode and allows the session owner or a shared account's sessions. **Note:** the existing `/diff` and `/diff/file` routes do not call it; reading file contents is the more sensitive operation, so the file viewer routes do, and the gap on the diff routes is not widened by this work. The wider question of a read-access policy for worker routes and worker WebSockets in multi-user mode is tracked in #2201; the viewer keeps `assertCanOperateSession` meanwhile.

### Path safety

Two layers, both required:

1. **Lexical guard.** `isValidFilePath` in `packages/server/src/services/git-diff-service.ts` rejects absolute paths, any path containing `..` (as a substring, so a file named `a..b` is also rejected -- accepted, rare), and any path containing a NUL byte. It is a module-private function today (`getFileLines`, `getFileDiff` and the other callers are in the same file), so the implementation exports it (or hoists it to `lib/`) rather than copying it. The tree route accepts the empty string as the root; the content route requires a non-empty path.
2. **Containment after symlink resolution.** This layer is now the only thing that keeps a symlink from leading outside the working directory, because the listing follows nothing and filters nothing; it is load-bearing, not belt-and-braces. The lexical guard does not stop a symlink inside the worktree that points outside it. Symlink rules: the tree route lists a symlink as `kind: 'symlink'` without resolving it; expanding one (tree route with its path) or opening one (content route) resolves `realpath` and refuses a target outside `locationPath` with the 400 / 403 cell of the boundary table; a symlink inside the worktree that points inside it works like its target. The file viewer applies the embedded-agent confinement rule ([embedded-agent-worker.md](embedded-agent-worker.md), "Follow symlinks via `realpath`"): resolve the target with `realpath`, walking up to the nearest existing ancestor if the leaf does not exist, and accept it only if it equals `realpath(session.locationPath)` or is prefixed by it plus `path.sep`. The embedded agent's helper `resolveConfinedPath` (`packages/embedded-agent/src/tools/path-confinement.ts`) is in another package and runs in the agent subprocess; the implementation either reuses its logic through `packages/shared` or states why a server-side copy is required (a duplication check applies, per the workflow rule). In multi-user mode the `realpath` itself must run as the session owner, because the server user cannot traverse a 0700 directory. It is its own elevated call, made BEFORE the read or the listing, so containment is decided before either uses the path: one shell resolves the real working directory and the real target (two lines of output; no shell variable and no `$` anywhere in the command, because the elevated login shell expands `$` before the inner `sh` runs) and the check itself (`target === root` or `target` prefixed by `root + sep`) is made in TypeScript, identically in both modes. (The first draft put the `realpath` in the same call as the read; that would have made the read builder, which the diff paths share, carry the viewer's containment predicate.) Only existing paths are viewed, so the walk-up to the nearest existing ancestor, which a write target needs, has nothing to decide: a target that does not exist (a dangling symlink included) is a 404, and the command's explicit `test -e` makes that hold on every `realpath` (GNU's default tolerates a missing last component). `realpath(1)` is a runtime requirement of the elevated path: GNU coreutils on Linux; on macOS it is present on current releases (verified against the macOS 15 man page) and absent on Mojave and earlier, the first release that ships it is not verified here. Where it is missing the elevated path fails loudly: exit 127 from the resolve command, logged as 'File viewer realpath failed', surfaced as a 500. The check and the read are separate calls, so a symlink swapped in between is not caught -- the same window the embedded agent's confinement has. The containment predicate is the only piece shared in spirit with `resolveConfinedPath`: its filesystem calls run in-process in the agent subprocess and cannot run as another OS user, so the server has its own few lines.

### Tree source: a directory listing, as the session owner

The tree is a plain listing of one directory level, with no filter of any kind: dotfiles and `.git` are listed, nothing is hidden by name, by `.gitignore`, or by size. It works identically for a git worktree, a plain directory and a quick session's directory (no git is involved). Expanding `.git/objects` is harmless because the content route still applies the 1 MiB cap and binary detection.

**Direct path (single-user mode, also macOS and any case where elevation is bypassed).** `readdir(join(locationPath, dir), { withFileTypes: true })`, the same call `buildDefinitionMemoryCleanupTargets` in `packages/server/src/lib/session-data-path.ts` already uses. `isDirectory()` maps to `dir`, `isSymbolicLink()` to `symlink`; everything else (regular files, fifos, sockets, devices) maps to `file`. Entries are sorted directories first, then by name with a byte comparison (plain `<` on the name strings, not `localeCompare`), so the order does not depend on the host locale.

**Elevated path (multi-user mode).** The server user cannot list a 0700 directory owned by the session owner, so the listing runs through `runAsUser` in `packages/server/src/services/privilege-elevation.ts` with `cwd = locationPath`:

```
find <escaped dir> -mindepth 1 -maxdepth 1 -type d -print0; printf '\0\0'; \
find <escaped dir> -mindepth 1 -maxdepth 1 -type l -print0; printf '\0\0'; \
find <escaped dir> -mindepth 1 -maxdepth 1 ! -type d ! -type l -print0
```

All three runs go in ONE elevated runner call (one shell, `cwd = locationPath`), behind a `test -d` probe (exit 44 when the existing target is not a directory, so `find` on a file does not read as an empty listing). `dir` is wrapped in `shellEscape` like every path in `runAsUser` commands. **Every shell command run through the elevated runner addresses its target by ABSOLUTE path, produced after the containment check; none relies on the wrapper's `cd <cwd>`, because the inner command runs even when that `cd` does not take effect.** For the listing that path is the target's REAL path (the containment check's result), so it has no symlink component and `find` needs no `-H`; expanding a symlink to a directory therefore lists the target's entries. The server splits the output on the double-NUL section separators and maps section 1 to `dir`, section 2 to `symlink`, section 3 to `file`. A symlink is reported as such, not followed, because `-L` is not used. Sorting is the same as the direct path, done by the server. Identity is `resolveSpawnUsername(session.createdBy, userRepository)`, as for the content read; the route hands the service that name only when `shouldElevateForUser` says an elevated shell is actually needed, and `null` otherwise (single-user mode, or the spawn user is the server user), so those cases use the direct path.

Only the portable BSD/GNU subset of `find` is used (`-mindepth`, `-maxdepth`, `-type`, `-print0`; no `-printf`), so the elevated branch works on every multi-user host the setup guide supports (Linux or macOS). The third run is the complement `! -type d ! -type l`, not `-type f`, so that fifos, sockets and devices are listed as `file` instead of being dropped, matching the direct path. A double-NUL separator is unambiguous because a file name cannot contain NUL: inside a section every name is followed by exactly one NUL, so two consecutive NULs can only be the separator (an empty section is just the separator on its own).

One level per request; entries carry no `size` in v1 (the content response already carries the total size, and a later query parameter can add sizes without breaking the wire).

**Tree entry:**

```typescript
// Derived from the schemas in packages/shared/src/schemas/file-viewer.ts (the schema is the
// single writer; there is no packages/shared/src/types/file-viewer.ts and no hand-written twin)
interface FileTreeEntry {
  name: string;               // single path segment
  kind: 'dir' | 'file' | 'symlink';   // a symlink carries no target
}

interface FileTreeResponse {
  path: string;               // the directory that was listed ('' = root)
  entries: FileTreeEntry[];
}
```

**Symlinks are listed as their own kind and never followed by the listing.** Following happens only when the user expands or opens one: expanding sends the symlink's path to the tree route, opening sends it to the content route, and both resolve `realpath` and refuse a target outside `locationPath` (see [Path safety](#path-safety)). A symlink inside the worktree that points inside the worktree behaves like its target. The UI shows a symlink with its own icon and treats a click as "try to expand or open", so a broken or escaping link yields the route's error, not a silent no-op.

### Content read as the session owner

**The server process must not read the file directly in multi-user mode.** The worktree may be 0700 and owned by the session owner, and the server user cannot open files in it.

A pre-existing gap of exactly this shape exists today: `getFileLines` in `git-diff-service.ts` reads the `working-dir` ref with `readFile(join(repoPath, filePath))` as the server process, and its `requestUser` parameter is documented as "Ignored on the 'working-dir' branch (direct filesystem read)". It fails on a 0700 user worktree in multi-user mode. This is tracked in #2199 and is not fixed by this work; **the file viewer must not copy it.**

Mechanism: `runAsUser` in `packages/server/src/services/privilege-elevation.ts` with `username = resolveSpawnUsername(...)`. Its `command` is passed verbatim to `sh -c`, so every path is wrapped in `shellEscape` (exported from the same module, used by its other callers) and the command ends options with `--`:

```
head -c <FILE_VIEWER_MAX_BYTES + 1> -- <escaped path>
```

`cwd` is `session.locationPath`; **the path in the command is absolute (`shellEscape(join(locationPath, relPath))`), and the command does not rely on `cd <cwd>`** (the real-shell tests run it from a directory that is not the target). The content read must assert a REGULAR file before reading, because `cat` on a fifo blocks until the time box. For the elevated path the command is `test -d X && exit 42; test -f X || { test -e X && exit 43; }; wc -c < X; head -c <cap> -- X`, where exit 43 means "exists but is not a regular file" and the service maps it to a `ValidationError` (400) "not a regular file"; a path that does not exist falls through to the read and fails there with `No such file`, as without the option. The direct path checks `stat().isFile()` and refuses the same way. `test -f` follows symlinks, so a symlink to a regular file inside `locationPath` still opens, after the realpath containment check, which therefore runs first. This is the option `{ regularOnly: true, maxBytes }` on the #2199 builder `buildWorkingTreeReadCommand` and on `readWorkingTreeFile` (one builder, not a second one beside it), and its real-shell test file gains the cases: fifo -> exit 43, symlink-to-regular-file -> exit 0, and the bounded output shape. The #2199 default stays byte-identical for the diff paths (exit 42 only, `cat`). The total size comes from the same command (`wc -c`, one line before the content: GNU prints `123`, BSD pads with spaces), so the response can say "first 1 MiB of N" without a second call, and truncation is decided from that size, never from the length of the bytes that came back (the elevated path returns stdout as a UTF-8 string). When elevation is bypassed (single-user mode, `AUTH_MODE=none`, or the spawn user equals the server user), `runAsUser` runs the same command directly; the implementation may use a direct `readFile` plus a bounded slice in that branch only if a test proves both branches return the same response for the boundary values below. A test per mode is required (pre-PR completeness Q9: single-user, multi-user with the server user as owner, multi-user with another owner).

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
| A symlink to a directory inside `locationPath`, expanded | lists the target's entries |
| A symlink to a file outside `locationPath`, opened | 400 / 403 `ValidationError`, never content |
| A fifo or socket | listed as `file`; opened -> 400 `ValidationError` "not a regular file", never a blocked `cat` |
| A symlink to a regular file inside `locationPath`, opened | content |
| A dotfile such as a dot-env file | listed and readable like any file (owner direction) |
| `.git` | listed as a directory (collapsed like any other) |
| A directory that is not a git repository | listed like any other directory |

### Wire shapes

```typescript
// Derived from packages/shared/src/schemas/file-viewer.ts
type FileContentKind = 'text' | 'binary';

interface FileContentResponse {
  path: string;               // echoes the validated request path, stable across reloads
  kind: FileContentKind;
  content?: string;           // present for 'text' only
  size: number;               // total bytes on disk
  truncated: boolean;         // true only when kind === 'text' and the cap cut the content
  language: string;           // Prism language name, 'text' when unknown
}
```

Both responses are `v.strictObject` schemas in `packages/shared/src/schemas/`, parsed by the client, per the schema-type parallel maintenance rule (pre-PR completeness Q10); an integration test in `packages/integration/src/` exercises server-populates, serialise, schema-parse, client shape.

`language` is computed on the server from the file name so the client does not need the map for the wire, but the client owns the Prism language set (see [Highlighting](#ui)); the server value is a name from that same set or `'text'`. The extension-to-language map has ONE writer, `packages/shared/src/utils/prism-language-for-path.ts` (`prismLanguageForPath`, with the list of names it can emit, `PRISM_LANGUAGE_NAMES`, pinned by a test); it carries the behaviour of `DiffViewer.tsx`'s former private `getLanguageFromPath` unchanged, and the client maps the wire's `'text'` to Prism's `'plain'`. The content schema also enforces the cross-field rules at the parse boundary: `text` carries `content`; `binary` carries neither `content` nor `truncated: true`.

## UI

### Highlighting: the existing Prism stack

`prism-react-renderer` (`Highlight`, `themes.vsDark`), with additional grammars registered by `packages/client/src/lib/prism-languages.ts` (ruby, bash, css, scss, less, typescript, javascript, sql, ...), which first imports `packages/client/src/lib/prism-setup.ts` to publish the global `Prism` instance. No new dependency.

**What the code actually does today (read from `DiffViewer.tsx`).** `packages/client/src/components/workers/DiffViewer.tsx` is **neither virtualised nor length-capped**. It renders every diff line as a DOM row; `HighlightedLine` runs one `Highlight` per line (tokenising the single line, using `tokens[0]`), and long unchanged regions are bounded only by the diff itself being a diff (context gaps expand by `MAX_EXPAND_LINES = 20` at a time). The extension-to-language map is **not** in `prism-languages.ts`: it is a private function `getLanguageFromPath` inside `DiffViewer.tsx` (extensions plus a few special file names, `'plain'` as the fallback). Unlike a diff, a file viewer renders a whole file, so copying the diff approach unchanged would render up to a million characters as thousands of per-line `Highlight` instances.

Decision for the viewer, given the 1 MiB server cap:

- The language map is hoisted from `DiffViewer.tsx` into a shared client helper (for example `packages/client/src/lib/prism-language-for-path.ts`) used by both `DiffViewer` and the viewer. The hoist is part of the implementation PR, with the fallback unified (the diff uses `'plain'`; the wire says `'text'`; the helper maps `'text'` to the Prism name `'plain'`).
- The file is tokenised **once** per `(path, content)` with a single `Highlight` over the whole content (so multi-line constructs such as block comments and template strings highlight correctly, which the per-line approach in the diff cannot do), and **only when `content.length <= FILE_VIEWER_HIGHLIGHT_MAX_BYTES = 256 KiB`** (a client constant). Above that, the content renders as plain text with line numbers and the notice "highlighting off for files over 256 KiB".
- Rendering is **always windowed by scroll position**, with a fixed monospaced row height: only the visible token rows plus an overscan are mapped to DOM rows, with no list library (none exists in the repository; checked: no match in `packages/client/package.json` or `src`). This applies to the highlighted and the plain-text paths alike. It changes no wire shape and no surface cell.
- The implementation PR must record a **measured tokenise time** for a 256 KiB and a 1 MiB TypeScript file (the 1 MiB figure shows what the 256 KiB threshold avoids).

### Layout

- **Desktop:** two panes. Left: the tree (lazy expand on click of a directory, directories first then name sort, the open directories' state in component state). Right: the selected file, with line numbers, the path shown as a header, and a truncation or binary notice where applicable. A Refresh button in the tree header re-lists every open directory and re-reads the selected file.
- **Mobile:** `useIsMobile` (`packages/client/src/hooks/useIsMobile.ts`) switches layout. It is used by `SessionPage.tsx` (for the side-panel drawer), `routes/__root.tsx` and the terminal keyboard input; the worker view components do not use it today, so this is the first worker view to branch on it. The viewer follows the pattern `SessionPage` already uses for the side panels: when mobile, the tree is a toggle drawer over the content, opened by a button in the header and closed on file selection. Branch with the hook, not with `md:hidden`, for the same reason `SessionPage` documents (the hidden subtree would still mount).
- **Tab:** `packages/client/src/components/sessions/tabAppearance.ts` gains a `file-viewer` case in each exhaustive switch (`getTabDotColor`, `getWorkerTypeLabel` -> `'File Viewer'`) and returns true from `isCloseableTabType`. `SessionPage.tsx` renders an icon for `git-diff` tabs (`DiffIcon`) instead of the status dot; `file-viewer` gets its own icon in the same branch, and the active-tab switch renders a new `FileViewerWorkerView` next to `GitDiffWorkerView`.

### Creation: the add-worker menu

The add-worker control in `SessionPage.tsx` is `AddAgentWorkerMenu` (`packages/client/src/components/sessions/AddAgentWorkerMenu.tsx`, props `onSelect` / `onSelectShell`), backed by `addAgentTab` / `addTerminalTab` in `packages/client/src/components/sessions/hooks/useTabManagement.ts`, which call `createWorker` from `lib/api`. **The `git-diff` worker is not created from this menu**: it is created server-side with the session. The file viewer therefore needs a new menu item and a new callback (`onSelectFileViewer` -> `addFileViewerTab`, posting `{ type: 'file-viewer' }`), placed beside the "Shell" item, which is the other item that has no agent options. The menu's header comment ("lists a plain Shell item, terminal AgentDefinitions and EmbeddedAgentDefinitions") is updated in the same PR.

## Persistence

The `workers` row stores `id`, `session_id`, `type`, `name`, `created_at`, and nothing type-specific for `file-viewer` (the git-diff worker's `base_commit` has no counterpart). Nothing about selection or expansion is persisted. On server restart the worker is restored as a plain in-process worker with no activation work. No migration; the persisted-type union and the mappers (`toPersistedWorker`, the repository mappers) gain the variant.

## Surfaces

Decision table per [decision-table.md](../../.claude/rules/decision-table.md). Rows are operations; columns are surfaces. Every cell is `do:` or `not here:`; there is no undecided cell. The UI cells (worker tab, add-worker menu) are **owner-confirmed 2026-10-18**.

| Operation | Worker tab | Add-worker menu | REST | Worker WebSocket | MCP `create_worker` / `delegate_to_worktree` options | Embedded-agent-visible |
|---|---|---|---|---|---|---|
| Create viewer | not here: a tab is the result of creating, not a way to create one. (owner-confirmed 2026-10-18) | do: new "File viewer" item in `AddAgentWorkerMenu` (`onSelectFileViewer` -> `addFileViewerTab` in `useTabManagement.ts`). (owner-confirmed 2026-10-18) | do: `POST /api/sessions/:sid/workers` with `{ type: 'file-viewer' }` (new `CreateWorkerRequestSchema` variant) | not here: creation is the REST route. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| List tree | do: `FileViewerWorkerView` left pane (lazy expand, directories first, name sort; mobile: toggle drawer), including dotfiles and `.git`; nothing filtered. (owner-confirmed 2026-10-18) | not here: the menu only creates workers. (owner-confirmed 2026-10-18) | do: `GET .../workers/:wid/files/tree?path=<dir>` (one directory level) | not here: listing is the REST tree route. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Read file | do: `FileViewerWorkerView` right pane (highlighted, line numbers, truncation / binary notices). (owner-confirmed 2026-10-18) | not here: the menu only creates workers. (owner-confirmed 2026-10-18) | do: `GET .../workers/:wid/files/content?path=<file>` | not here: reading is the REST content route. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Refresh | do: Refresh button in the tree header (re-lists open directories, re-reads the selected file). (owner-confirmed 2026-10-18) | not here: the menu only creates workers. (owner-confirmed 2026-10-18) | not here: refresh is the client calling the two GET routes again; the server has no cache to invalidate. | not here: refresh is the client calling the two GET routes again. | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Live updates (watch and push changes) | do: `FileViewerWorkerView` opens the worker WebSocket while mounted and applies the invalidation rule; on `watch-unavailable` it shows the notice "Live updates are unavailable here; use Refresh"; a removed selected file shows "File removed" instead of an error pane. (owner-confirmed 2026-10-19) | not here: the menu only creates workers. (owner-confirmed 2026-10-19) | not here: the push channel is the worker WebSocket; the two GET routes are unchanged. | do: the viewer's own worker WebSocket carries the server-to-client `files-changed` and `watch-unavailable` messages (no client messages); see [Live updates](#live-updates). (owner-confirmed 2026-10-19) | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |
| Comment (later) | not here: later version, designed in [Later: comments to the main agent](#later-comments-to-the-main-agent); v1 builds nothing. (owner-confirmed 2026-10-18) | not here: the menu only creates workers. (owner-confirmed 2026-10-18) | not here: later version; v1 reserves only a stable `path` and `language` on the content response. | not here: later version; the comments design reuses this channel for reply events (see [Later: comments to the main agent](#later-comments-to-the-main-agent)). | not here: a viewer is a human surface; agents read files with their own tools. | not here: a viewer is a human surface; agents read files with their own tools. |

Notes on the table:

- The "Live updates" row is included because question 1 made it a real operation with a decided v1 answer (not built, Refresh only); it is now decided for the follow-up Issue #2205 by the [Live updates](#live-updates) design. The "Worker WebSocket" column is new with that design: the surface exists in v1 only as an explicit refusal, so every other row records why it does not use it. The comments feature and the dot-env editing direction have no Issue yet; each is filed when v1 merges (prose note, see the Later sections).
- MCP cells are `not here` for a reason that is the Issue's own framing. `delegate_to_worktree` and `create_worker` expose agent-selection options; a viewer has none, so a caller that wants file contents uses its own Read / Glob / Grep tools, which see the same tree. If the owner later wants a session to open a viewer for the user (for example, "open this file for me"), that is a new operation and a new row.
- The "embedded-agent-visible" column follows `AGENT_OPERATIONS` in `packages/shared/src/types/agent-operations.ts` in spirit but not in type: the file viewer is not an agent operation, so no `satisfies Record<AgentOperation, SurfaceExposure>` table is added. The decision is recorded here, in the document, where [decision-table.md](../../.claude/rules/decision-table.md) puts it.

## Live updates

Design for the follow-up Issue #2205, implemented (PR #2221 schema, PR #2222 server, PR #2228 client): the client half is `useFileViewerLiveUpdates`, the "File removed" pane, the `watch-unavailable` notice and a deleted expanded directory collapsing; the server half is the shared watcher, the viewer's worker WebSocket and the pause and delete teardown. Every statement about existing code names a file and a symbol and was read on `main` at 1bfd92a2; a statement marked **premise** was not measured, one marked **measured** was.

### Transport

The viewer needs something to tell it that files changed. Three options:

| Option | Mechanism | Wire change | Cost | Gives up |
|---|---|---|---|---|
| (a) Worker WebSocket | Lift the v1 refusal (`websocket/routes.ts`, `UNSUPPORTED_OPERATION` for `file-viewer`); the viewer's own worker WebSocket carries server messages only | A new server-message union in `packages/shared/src/schemas`: `SCHEMA_VERSION` moves (owner Y) and the wire-consumption fixtures are touched | Zero requests while nothing changes; one message per debounce window when something does | A directory the server user cannot watch (multi-user, 0700) gets Refresh only |
| (b) App WebSocket event | A session-scoped event on `/ws/app` | The same, in `app-server-message.ts` (a protocol-dispatch trigger file) | The same as (a), but every connected client receives the frame and filters it | Couples a per-worker concern to the app-wide stream |
| (c) Polling | The client re-reads the open directories and the selected file on an interval | None | One request per open directory plus one for the file per interval, per open viewer; in multi-user mode each listing or read is an elevated login shell (`runAsUser`) | Latency up to the interval, and constant load while the viewer is open |

**Decision: (a).** The viewer already has a worker identity, `git-diff` is the exact precedent (its own worker WebSocket with its own message union, `GitDiffServerMessage`), and (a) costs nothing at rest. (b) is rejected because it broadcasts a per-viewer concern. (c) is rejected as the default because its cost is paid continuously and, in multi-user mode, as a login shell per request; but it is the only option that works for a directory the server user cannot watch, so it is the natural fallback if that gap matters in practice (see the multi-user paragraph).

Decided by the owner (2026-10-19): (A), the worker WebSocket, including the `SCHEMA_VERSION` move.

**Wire.** The viewer's worker WebSocket is server-to-client only:

```typescript
// Declared in packages/shared/src/schemas/file-viewer.ts (the schema is the single writer), a v.strictObject union
type FileViewerServerMessage =
  | { type: 'files-changed'; paths: string[]; overflow: boolean }   // paths are relative to locationPath, no leading slash
  | { type: 'watch-unavailable'; reason: 'permission-denied' | 'watch-failed' };
```

No client messages exist; a client message is answered with the existing `error` frame, code `UNSUPPORTED_OPERATION` (the code already means "client message not valid for this worker type"). Access: `assertCanOperateSession` at open, the same as the two REST routes, because even bare paths of changes are metadata about another user's directory. **Pause and resume.** With this design the viewer holds a watch subscription and an open socket, so it is torn down by a pause like the diff worker. (1) The pause branch in `session-pause-resume-service.ts` (a `file-viewer` branch that is a no-op today, next to the `git-diff` branch that stops its watcher) unsubscribes the viewer's subscription, and the last unsubscribe closes the `fs.watch`; the viewer's open sockets close with `SESSION_PAUSED`. (2) A viewer socket opened during the pausing window is refused with `SESSION_PAUSED`: the pausing check (`isPausing`) in `websocket/routes.ts` sits after the `git-diff` and `file-viewer` branches today, so the implementation moves the file-viewer open branch below it, or repeats the check inside the branch. (3) On resume nothing reopens the socket by itself: a `SESSION_PAUSED` closure is final for the client reconnect policy, so the viewer's socket reopens only because `SessionPage` remounts the active tab after the resume. The client reconnect policy is unchanged: `websocket-reconnect.ts` already treats a normal closure as final.

The dispatcher on both sides ends its `switch` with the `default: { const _exhaustive: never = message; ... }` guard, and the implementation adds a wire-consumption fixture test keyed by message type (pre-PR completeness Q10), plus an integration test in `packages/integration/src/` for server-populates, serialise, parse, client-shape.

### The watcher

**Read from `git-diff-service.ts` before PR-A (this paragraph records the premise of the extraction).** `startWatching(repoPath, onChange)` keeps ONE state per path: a module-level `watchers` map keyed by `repoPath`, and its first statement is `stopWatching(repoPath)`. So a second caller for the same path replaces the first caller's callback and closes the first caller's `fs.watch`: there is a single subscriber per path, not a set. The callback takes no arguments (the changed filename is used only to filter and is not passed on), the debounce is a trailing 300 ms (`DEBOUNCE_DELAY`, reset by every event), and the ignore filter (`shouldIgnore`) is a substring match of `fileWatchIgnorePatterns` against the filename. The same single-subscriber shape bites the diff worker itself: `handleDisconnection` in `git-diff-handler.ts` calls `stopWatching(locationPath)`, which would silence a viewer watching the same path.

**Decision: a refcounted subscriber set, not a second watcher.** The implementation extracts the watching into a function that returns an unsubscribe (`subscribe(path, subscriber) => () => void`): one recursive `fs.watch` per path, opened by the first subscriber and closed when the last leaves, each subscriber holding its own ignore predicate and its own debounce and coalescing state. `startWatching` and `stopWatching` keep their signatures and become the diff worker's subscriber, so the diff behaviour is unchanged and the replace-on-second-caller gap closes for it too. The diff watcher's own `.log` substring over-match (`catalog.logic.ts` is dropped by `filename.includes('.log')`) is fixed by the same extraction, by matching on whole path segments, with `catalog.logic.ts` pinned as the counter-example (a file named `error.log` must still be ignored, so a pattern that names an extension, `.log`, matches a segment that ends with it; every other pattern matches a segment equal to it). A second independent `fs.watch` for the viewer is the rejected alternative: it leaves the diff worker's gap in place and doubles the kernel watches over the same tree (the cost of a recursive watch on the host was not measured; **premise**).

**Ignore patterns: not the diff list.** The viewer lists everything, so it must not use `fileWatchIgnorePatterns`: that list ignores `.env.local`, `dist`, `build`, `coverage`, lockfiles and `.log`, all of which the viewer shows and the owner wants reachable, and a substring match on `.log` also hides `catalog.logic.ts`. The viewer ignores exactly two path segments, `.git` and `node_modules`, matched on whole segments (a changed path with any segment equal to one of them is dropped): both generate thousands of events from ordinary commands (`git status`, `bun install`) and neither is read live. The gap is stated: a change under `.git` or `node_modules` is not pushed, Refresh shows it.

**Multi-user 0700.** The watcher runs as the SERVER process. A directory owned by another user with mode 0700 cannot be traversed by the server user, so `fs.watch` on it throws (EACCES; **measured** with Bun 1.3.14 on Linux: `fs.watch(dir, { recursive: true })` on a directory with mode 000 throws an error with `code: 'EACCES'` at the call, and `file-watch-service-real-fs.test.ts` pins that the subscriber then receives `permission-denied`; it is the same class of gap this document already records for `getFileLines`, #2199). The subscribe call catches the failure and the server sends `watch-unavailable` with `reason: 'permission-denied'` (other failures: `'watch-failed'`), then keeps the connection open and sends nothing else; the viewer shows the notice and keeps working through Refresh. It never fails silently and never fails the viewer. Running the watcher as the session owner is not proposed here: it would need a long-lived elevated process per viewer, which is a different feature.

### Debounce, coalescing, granularity

- **Debounce:** trailing 300 ms (the diff worker's value), reset by every non-ignored event, **with a maximum wait of 2 s** so a continuous writer (a build, a log tail) still produces a message every 2 s instead of never.
- **Coalescing:** during a window the subscriber collects the DISTINCT relative paths. At most **200** are kept; the 201st distinct path sets `overflow: true` and further paths are not recorded (bounded memory). A `git checkout` or `bun install` outside the ignored segments therefore produces ONE message `{ paths: [<=200 paths>], overflow: true }`, not thousands.
- **Granularity (client rule).** For each changed path `p` the client invalidates `fileViewerKeys.tree(sessionId, workerId, dirname(p))` (`''` for the root) and, when `p` is the selected file, `fileViewerKeys.content(sessionId, workerId, p)`. Only mounted (active) queries refetch; an inactive key is merely marked stale, so a change inside a collapsed directory costs nothing and shows on the next expand. On `overflow: true` the client invalidates the whole worker prefix `fileViewerKeys.worker(sessionId, workerId)`, which is exactly what Refresh does, so the work is bounded by the open directories plus the selected file. A creation or deletion of an entry is seen through its parent directory.
- **Reconnect.** On every (re)open of the WebSocket after the first, the client invalidates the worker prefix once, because changes during the gap are lost (messages are not acknowledged or replayed).
- **Rename and delete of the selected file.** A rename is two events (old and new name); no rename tracking is attempted: the old name disappears from its parent's listing, the new name appears. The content refetch of the selected path then answers 404; the right pane shows "File removed" with the path, the selection is kept (a re-created file at that path shows again on the next change), and the pane is not an error pane. A deleted directory that was expanded answers 404 on its tree route: it collapses silently and is dropped from the open set.
- **Lifetime.** `SessionPage` renders only the active tab's view, so the WebSocket, and with it the subscription, exists only while the viewer tab is active; closing the tab or leaving the page unsubscribes, and the last unsubscribe closes the `fs.watch`. The subscription is keyed by worker id, like the diff worker's, so a second browser tab on the same viewer replaces the first tab's subscription.

## Later: comments to the main agent

No code in v1. This section fixes the model so v1 does not close the door.

**Model.** A comment is `{ path, startLine, endLine, body }`, anchored to a line range of a file as the viewer showed it. The user writes it in the viewer; it is delivered to the session's main agent worker; the agent's reply returns to the viewer.

**Delivery.** Through the existing `SessionManager.deliverWorkerNotification` seam (`packages/server/src/services/session-manager.ts`), the same path that inbound events, timers, conditional wakeups and todos use. The seam routes to a PTY-backed worker through `writePtyNotification` and to an embedded-agent worker through its system-notification path, and returns `{ ok: false, reason }` otherwise. A comment is therefore a notification with a rendered body such as "File comment: `src/a.ts` lines 10-12: <body>", addressed to the session's primary agent worker. The viewer worker is not itself a notification target (it is neither PTY-backed nor an embedded agent), so the predicate `canReceiveNotifications` is unchanged.

**Reply.** The agent answers by an MCP tool call (a new tool, designed then) that the server turns into a `file-viewer` worker event pushed to the viewer, the way review annotations reach the diff viewer. This is the point at which the viewer gains a live channel: a worker WebSocket for events. The [Live updates](#live-updates) design already introduces that channel for file changes, so reply events are added as a further server message on it.

**What v1 reserves:**

- A stable `path` on the content response (always the validated, repository-relative path), so a comment can name the file without re-deriving it.
- A `language` on the content response (already needed for highlighting).
- Line numbers in the rendered content that match the lines of the returned text (the truncation cuts at the end only, so line numbers of the shown prefix are the file's line numbers).
- The `file-viewer` worker type itself, so events have an address.

**What v1 does not build:** comment UI, comment persistence (no table and no column), the delivery code, the reply tool and event, anchoring that survives the file changing underneath a comment (a later design must choose between line-based anchors with a staleness check and content-hash anchors; v1 takes no position), and any WebSocket channel for the viewer.

## Decisions by the owner (2026-10-18)

### 1. Live updates

**Decided: (A), owner, 2026-10-18.** No live updates in v1; the tree header has a Refresh button only. Live updates (a worker WebSocket channel, optionally riding the git diff worker's watcher: `startWatching` in `packages/server/src/services/git-diff-service.ts`, driven from `git-diff-handler.ts`) are the follow-up Issue #2205, designed in [Live updates](#live-updates). The rejected option (B) was sharing that watcher in v1.

### 2. Directories that are not git repositories

Superseded by the plain directory listing: a non-git directory is listed like any other.

### 3. Showing ignored files

Superseded by the plain directory listing: nothing is filtered, ignored files included.

## Later: editing dot-env-class files

The owner's stated direction is to inspect, and later EDIT, configuration files such as dot-env files from the viewer. v1 is read-only and builds no write route. A later design adds a write route with the same containment and identity as the read routes, and must decide the audit and confirmation shape. An Issue for it is filed when v1 merges.

This direction adds weight to #2201: a viewer that can show another user's dot-env secrets in multi-user mode makes the worker-route read-access policy a question with a concrete payload, and the write direction makes it a write-access question too.

## Implementation Tasks

1. Shared: `FileViewerWorkerSchema`, the `CreateWorkerRequestSchema` variant, the `Worker` / app-server-message unions, `FileTreeResponse` / `FileContentResponse` types and schemas (`v.strictObject`), `FILE_VIEWER_MAX_BYTES` documented in `server-config.ts`; regenerate `SCHEMA_VERSION` (`bun run build`).
2. Server: `InternalFileViewerWorker`, worker creation / persistence / conversion / deletion / restart-all handling at every `git-diff` site; export `isValidFilePath`; a `file-viewer-service` (tree via `readdir` (direct) / three portable `find -print0` runs (elevated), content via `runAsUser`, realpath containment, binary and size rules); the two routes with `assertCanOperateSession`.
3. Client: `FileViewerWorkerView` (tree + content, mobile drawer), the hoisted language helper (and `DiffViewer` switched to it), always-windowed rendering, highlighting only up to 256 KiB (measured tokenise time for 256 KiB and 1 MiB recorded in the PR), `tabAppearance.ts`, `SessionPage.tsx` icon and view branches, `AddAgentWorkerMenu` item and `addFileViewerTab`.
4. Tests: every boundary value in the table above; one test per mode (single-user, multi-user server-owned, multi-user other owner); a symlink-escape test, a symlink-to-regular-file-inside-the-worktree test (opens), a fifo test (created with `mkfifo` in the test's temp dir; the case is skipped on a filesystem that refuses; listed as `file`, opened -> 400 "not a regular file"), symlink listing (kind `symlink`, expand inside and outside), a non-git temp directory, a dot-env file and `.git` listed and readable; a wire-level integration test in `packages/integration/src/`; a `tabAppearance` exhaustiveness test; browser QA with screenshots attached to the PR, including the mobile drawer.
5. Docs: README Features entry (`(in development)` until finished), `docs/glossary.md` entry (already added with this document), `session-worker-design.md` row (already added with this document).
6. Live updates (#2205; the owner decided the transport and the SCHEMA move on 2026-10-19; implemented in PR #2221 schema, PR #2222 server, PR #2228 client): the subscriber-set extraction in `git-diff-service.ts` with the diff behaviour pinned first, the viewer's worker WebSocket and `FileViewerServerMessage`, the client subscription and invalidation rule, the "File removed" and `watch-unavailable` states, the pause-branch change in `session-pause-resume-service.ts` and its tests (pause with an open viewer: the `fs.watch` closes and the socket closes with `SESSION_PAUSED`; a socket opened during pausing is refused), and the tests named in [Live updates](#live-updates); browser QA with screenshots including the multi-user degraded notice.
7. Follow-ups (filed by their owners, not by this work): `getFileLines` working-directory read as the server process (#2199); live updates (#2205); read-access policy for worker routes (#2201); comments and dot-env editing (Issues filed when v1 merges).
