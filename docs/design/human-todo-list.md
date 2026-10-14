# Human TODO List: stable, countable items for the humans (questions and actions)

Status: design proposal (not implemented). Issue [#739](https://github.com/ms2sato/agent-console/issues/739); implementation [#2080](https://github.com/ms2sato/agent-console/issues/2080). The storage change needs a database migration and the feature adds wire types, both the owner's call; the document's job is to make that a one-line yes or no.

Every claim about the code below was read at `origin/main` **`f083ef62`** and is cited as `file:line` at that SHA.

## History

This replaces the owner-decision queue design of 2026-10-13 (`docs/design/owner-decision-queue.md`, merged in 9f8d5d13). The owner's 2026-10-14 direction generalised it. **Kept unchanged:** database-backed storage and its argument; no foreign key to `sessions` (rows outlive the session); `supersedes`; a second resolution appends; the trigger-only `*-updated` app message; delivery of the resolution to the asking worker through `deliverWorkerNotification` with one new notification kind; every agent-side tool is session-claiming; `implicit-endorsed` stays dropped. **Changed:** the name and the table (`decision_requests` -> `todos`); the item model (a closed `kind`, a `title`, either an agent or a human creator, an assignee); two surfaces (a global list page and assignment); and the session-delete rule, which now differs by kind.

## 1. Problem

An Orchestrator session that needs a human today carries the request in its session memo. The carrier is `write_memo` (`packages/server/src/mcp/mcp-server.ts:1503`), which calls `MemoService.writeMemo(sessionId, content, resolver)` (`services/memo-service.ts:37`): a whole-file overwrite of `<memos dir>/<sessionId>.md` (write to a temp file, rename over the old one), rendered by `components/sessions/MemoPanel.tsx`. Three things go wrong, all structural:

- **No count, no stable id, no history.** The number of unanswered requests is not knowable without reading the whole memo; a request cannot be referred to; a rewrite erases it; a retrospective cannot count the ones that ended unanswered.
- **Answers are inferred.** Without a record, "the owner merged the PR, so they endorsed the concern" becomes a reading rule rather than a fact.
- **Commands for the owner live in the same memo.** A question awaiting an answer and a command awaiting execution are the same object to the human who has to act: something with a stable id, a status and a resolution. The "commands for the owner go in the memo" convention is what #2085 (a Copy control on command blocks) exists to patch.

The cost is observed: on 2026-10-13 the Orchestrator carried five open gates in one memo and re-read them on every turn. The owner's additions on 2026-10-14: a human adds and deletes items themselves in the UI, and an item can be assigned to another team member.

## 2. Model (v1)

A **TodoItem**:

| Field | Meaning |
|---|---|
| `id` | stable identifier (UUID); survives any rewrite of the memo |
| `kind` | `question` or `action` (closed list in v1) |
| `title` | one line, required: the list is scannable without opening items |
| `body` | markdown. A question: context and recommendation. An action: the command or instructions; a fenced block in it is where #2085's Copy/Run control renders |
| `createdBy` | `{ sessionId, workerId }` for an agent, OR `{ userId }` for a human; exactly one |
| `assigneeUserId` | nullable; null means anyone on the team |
| `status` | `open` / `done` / `superseded` / `dismissed` (closed list in v1) |
| `resolutionText` | nullable. Required for `done` on a `question`; optional on an `action` |
| `resolvedByUserId`, `resolvedAt` | set when resolved |
| `createdAt`, `updatedAt` | timestamps |

The two closed lists (kinds, statuses) are the scope-creep guard.

**`implicit-endorsed` stays out.** It is exactly the inference the queue exists to make unnecessary: a resolution is explicit, or the item is open. A status that records "the owner did not say anything but acted" would reintroduce the reading rule inside the data model, and every aggregation over it would count a non-answer as an answer. The earlier `expired` is now `dismissed`: it is a human act, or the consequence of a session deletion.

**Transitions.** `open` -> `done` (a human resolves it); `open` -> `superseded` (the creating agent records a newer item that replaces it, the `supersedes` argument, done in the same transaction as the new row); `open` -> `dismissed` (a human dismisses it, or the session-delete rule below).

**Boundary rules.**

- *Zero open items*: the session block is hidden and the badge is 0; `list_todos` returns an empty list, not an error.
- *A second `done`*: the text is appended to `resolutionText` (separated by a rule line), `resolvedAt` moves, the status stays `done`, and each resolution is delivered. A resolution never reopens an item.
- *`done` on a `question` with empty text*: refused (400).
- *Session delete, by kind (the one rule that differs):* open `question` items created by that session become `dismissed` (nobody can hear the answer); open `action` items stay open (the human still has to do it; `createdBy.sessionId` stays as provenance). One `UPDATE` in the session-deletion transaction, which `SessionDeletionService` already opens since the executor plumbing landed.
- *Resolving an item whose creating worker is gone*: the resolution is stored and the delivery failure is recorded; the status is `done` either way (storage is the record, delivery is best effort).

**Who may do what.** A team tool, like the memo and End Session: any team member may create, assign, resolve, dismiss and DELETE an item. Delete is a hard delete in v1; the audit case is the `dismissed` row, which stays. Agents may create, list and supersede their own session's items; agents may NOT resolve or delete (the human act is the point; "the agent verifies the action happened" is a v2 question). Multi-user visibility: every team member sees every item, consistent with memos today.

## 3. Storage: database-backed

Both storage precedents exist here. **File-backed per-session artifacts:** the memo; review annotations (`docs/design/diff-review-annotations.md`, `write_review_annotations`). **Database-backed lists:** `bookmarks` (migration v33, `database/connection.ts:2028-2066`, kept in sync by id-only `bookmark-created` / `bookmark-deleted` messages, `schemas/app-server-message.ts:433-441`), `timers` (`database/connection.ts:985-993`, no foreign key to `sessions`), and inbound-event notifications (`routes/notifications.ts`).

| Criterion | File-backed (memo-style) | Database-backed (recommended) |
|---|---|---|
| Stable ids that survive a rewrite | No: one overwritten file per session | Yes: a row per item |
| Aggregation (unanswered, by assignee, by session) and the **global list** | Not possible without scanning every session's file; deleted sessions lose theirs | A query over one table; rows outlive the session |
| Human-created items (no session at all) | Nowhere to put them | A row with a user creator |
| Assignment, cross-session | An assignee cannot find items session by session | One indexed query |
| Cost | No migration | One additive table: migration, repository, routes, MCP tools, panels |
| Blast radius of a bug | One session's file | A shared table |
| What it does better | **Zero migration** | |

**Recommendation: database-backed.** The properties the feature asks for (stable ids, a global list, assignment, items with no session) are exactly what a file-backed memo cannot give. The file option is rejected for the one reason in its last row, and the migration is the owner's decision.

### The owner-gate block (single source; the implementation Issue quotes it)

```sql
-- migration v50 (takes the next free version after v49, which another pending migration holds;
-- LATEST_SCHEMA_VERSION is 48 at f083ef62)
CREATE TABLE IF NOT EXISTS todos (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  body                 TEXT NOT NULL,
  created_session_id   TEXT,              -- agent creator; no FK (rows outlive the session)
  created_worker_id    TEXT,              -- agent creator; the resolution notification's target
  created_user_id      TEXT,              -- human creator
  assignee_user_id     TEXT,              -- null = anyone
  status               TEXT NOT NULL DEFAULT 'open',
  resolution_text      TEXT,
  resolved_by_user_id  TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CONSTRAINT todos_kind_check   CHECK (kind IN ('question', 'action')),
  CONSTRAINT todos_status_check CHECK (status IN ('open', 'done', 'superseded', 'dismissed')),
  CONSTRAINT todos_creator_check CHECK (
    (created_session_id IS NOT NULL AND created_worker_id IS NOT NULL AND created_user_id IS NULL) OR
    (created_session_id IS NULL AND created_worker_id IS NULL AND created_user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_todos_status_assignee ON todos (status, assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_todos_created_session ON todos (created_session_id, status);
```

Notes: the `CHECK` constraints follow `mcp_server_permissions_decision_check` (`database/connection.ts:2869`); the table is additive, following the `migrateToV33` shape. There is **no foreign key** on `created_session_id` (a row must outlive the session, as in `timers` and `bookmarks`) and none on the user columns either (a row must outlive everything it references; users are never deleted today).

## 4. Surfaces (v1)

**MCP, for agents** (a session-claiming pair: `create_todo` and `list_todos` join `SESSION_CLAIMING_TOOLS`, `mcp/session-claiming-tools.ts:11`, and gate the claimed `sessionId` through `checkCallerOwnsSession`, like `create_conditional_wakeup`; a terminal agent passes its own session and worker ids, an embedded agent defaults to its own):

- `create_todo({ kind, title, body, assigneeUsername?, supersedes? }) -> { id }`. Appends an `open` item. `assigneeUsername` is resolved to a user id server-side. `supersedes` names an open item of the same session and marks it `superseded` in the same transaction. A second call never overwrites the first.
- `list_todos({ status?, mine? })`: the session's own items; `mine` means assigned to this session's user. This is also how an agent catches up when a notification could not be delivered.

**REST, for the UI** (server-composed; the client renders only what these return, invariant N1 of `docs/design/notification-center.md`):

- `GET /api/todos?status=&assignee=&sessionId=`.
- `POST /api/todos` (human create: kind, title, body, assignee).
- `PATCH /api/todos/:id` (`assigneeUserId`, `title`, `body`, for open items).
- `POST /api/todos/:id/resolve { text? }`, `POST /api/todos/:id/dismiss`, `DELETE /api/todos/:id`.

Authorization is the team-tool rule of section 2 (any member), not `assertCanOperateSession`; the MCP tools are the only path that checks session ownership, because that is the only path with a claimed session.

**UI.**

- (a) A per-session block beside `MemoPanel`: "To-do (N)", N = the open items of this session; zero hides the block.
- (b) A **global `/todos` page** (a new route beside `routes/artifacts`, `routes/jobs`): all items, filters for status, assignee and session. This is what makes assignment usable: an assignee cannot find items session by session. It also hosts the human "add" and "delete" controls.
- (c) A **navigation badge** = the open items assigned to me, in the header navigation (`components/header/NavLinks.tsx`, `MobileNavMenu.tsx`).
- The body renders with the same markdown renderer as the memo (`react-markdown`, `MemoPanel.tsx:2`; the shared fenced-block Copy control is `MarkdownCodeBlock`, #2085), so #2085's command block lands once, for both.
- Assignment needs a **user directory**: `UserRepository` has `findById` but no list method, and no users API exists, so slice (b) adds `UserRepository.findAll()` and `GET /api/users` ({ id, username }); usernames are already visible to every member through `Session.createdByUsername`. In single-user mode there is one user and the assignment control is hidden.

**Delivery of the resolution.** Resolving stores the resolution, then notifies the creating worker through `SessionManager.deliverWorkerNotification(sessionId, workerId, params)` (`services/session-manager.ts:959`), the seam inbound events and timers use, so the agent hears "item X resolved: <text>" as a turn whether it was a question or an action. The notification needs ONE new kind: `PTY_NOTIFICATION_KINDS` (`packages/shared/src/types/system-events.ts:74`) gains `internal-todo-resolved`, with its interface in `lib/pty-notification.ts`. Because that list is read at runtime by the embedded-agent schema's picklist, adding it **moves `SCHEMA_VERSION`** even though no schema file's text changes (the picklist-source rule in `.claude/rules/pre-pr-completeness.md` Q10). Delivery is best effort and returns a structured failure reason (`WorkerNotificationResult`). A human-created item has no worker to notify.

**Realtime.** A trigger-only `todos-updated { type, sessionId? }` app message tells clients to refetch (N1). Do not copy `memo-updated`, which carries `content` (`schemas/app-server-message.ts:406`): it predates N1. The protocol-dispatch fixture rule applies at implementation. **Wire summary:** the `Todo` type and schema pair, the new notification kind and `todos-updated` are all client-reaching; one owner decision covers the DDL and the wire.

## 5. What changes for the Orchestrator skill

The memo keeps status; the list takes requests. Owner-facing questions AND owner-facing commands go through `create_todo`, and the answer or the confirmation arrives as a notification (or through `list_todos`). That text change belongs to slice (c) of the implementation, not to this design; the skill is not edited here.

## 6. Non-goals (v1)

Due dates, priority, comments or threads, agent-side resolve, Slack or webhook delivery, cross-repository scoping, per-item access control, time-based automatic expiry.

## 7. Implementation slices (sequential; each `Refs #2080`, the last `Closes #2080`)

- **(a)** Migration v50, repository, REST, MCP `create_todo` / `list_todos`, the per-session panel, `todos-updated`.
- **(b)** The global `/todos` page, assignment (`PATCH`, the user directory), the navigation badge, human create and delete.
- **(c)** The resolution notification kind (`PTY_NOTIFICATION_KINDS`, the `SCHEMA_VERSION` move), the kind-dependent session-delete rule in the deletion transaction, the Orchestrator skill text.

[#2085](https://github.com/ms2sato/agent-console/issues/2085) (the command block in a body) rides after slice (a) as its own Issue, shared with the memo renderer. Polarity each slice must carry, against today: a memo overwrite leaves the list intact; a second `create_todo` does not overwrite the first; the resolution reaches the creating session as a notification; a session deletion dismisses its open questions and leaves its open actions.
