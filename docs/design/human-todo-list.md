# Human TODO List: stable, countable items for the humans (questions and actions)

Status: implemented (slice (a) #2120, slice (b) #2129, slice (c) #2133, the closing slice); owner-approved DDL (2026-10-15). Issue [#739](https://github.com/ms2sato/agent-console/issues/739); implementation [#2080](https://github.com/ms2sato/agent-console/issues/2080). The storage change needs a database migration and the feature adds wire types, both the owner's call; the document's job is to make that a one-line yes or no.

Every claim about the code below was read at `origin/main` **`f083ef62`** and is cited as `file:line` at that SHA.

## History

v2 (2026-10-16): agent-recorded resolutions and status changes from the session sidebar, from the owner's dogfood: an agent asked three "may I merge X?" questions, the human answered "all OK to merge" in chat, the agent merged but could not close the items, so the record diverged from reality; and the sidebar could not change status. Sections below carry the v2 changes inline and mark them.

This replaces the owner-decision queue design of 2026-10-13 (`docs/design/owner-decision-queue.md`, merged in 9f8d5d13). The owner's 2026-10-14 direction generalised it. **Kept unchanged:** database-backed storage and its argument; no foreign key to `sessions` (rows outlive the session); `supersedes`; a second resolution appends; the trigger-only `*-updated` app message; delivery of the resolution to the asking worker through `deliverWorkerNotification` with one new notification kind; every agent-side tool is session-claiming; `implicit-endorsed` stays dropped. **Changed:** the name and the table (`decision_requests` -> `todos`); the item model (a closed `kind`, a `title`, either an agent or a human creator, an assignee); two surfaces (a global list page and assignment); and the session-delete rule, which is now keyed on the new `scope` field rather than on `kind` (revised 2026-10-14, see section 2).

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
| `scope` | `session` or `global` (closed list). `session`: work to be done inside that session, ends with it, requires `sessionId`. `global`: independent of any session, survives it; may still carry `sessionId` as provenance |
| `title` | one line, required: the list is scannable without opening items |
| `body` | markdown. A question: context and recommendation. An action: the command or instructions; a fenced block in it is where #2085's Copy/Run control renders |
| `sessionId` | nullable. The item's session: required for `scope = session` and for an agent creator; provenance otherwise |
| `createdBy` | `{ workerId }` for an agent, OR `{ userId }` for a human; exactly one (the session is the separate `sessionId` column, so a human can create a session-scoped item from the panel) |
| `assigneeUserId` | nullable; null means anyone on the team |
| `status` | `open` / `done` / `superseded` / `dismissed` / `withdrawn` (closed list in v1) |
| `resolutionText` | nullable. Required for `done` on a `question`; optional on an `action` |
| `resolvedByUserId`, `resolvedAt` | set when resolved. `resolvedByUserId` is the human whose decision this is: for an agent-recorded resolution (v2) it is the person the agent attributes the words to |
| `resolvedByWorkerId` | (v2) nullable. Null = a human resolved the item in the UI; set = an agent worker recorded a human's statement. The latest resolver is the record: a later human resolution clears it. Set only together with status `done` (enforced in the repository and pinned by a test, no `CHECK`) |
| `createdAt`, `updatedAt` | timestamps |

The closed lists (kinds, scopes, statuses) are the scope-creep guard.

**`implicit-endorsed` stays out.** It is exactly the inference the queue exists to make unnecessary: a resolution is explicit, or the item is open. A status that records "the owner did not say anything but acted" would reintroduce the reading rule inside the data model, and every aggregation over it would count a non-answer as an answer. The earlier `expired` is now split in two: `dismissed` is a human act, and `withdrawn` is the consequence of a session deletion (an item that ended unanswered or undone, kept so that count stays measurable).

**Transitions.** `open` -> `done` (a human resolves it); `open` -> `superseded` (the creating agent records a newer item that replaces it, the `supersedes` argument, done in the same transaction as the new row); `open` -> `dismissed` (a human dismisses it); `open` -> `withdrawn` (the session-delete rule below).

**Boundary rules.**

- *Zero open items*: the session block is hidden and the badge is 0; `list_todos` returns an empty list, not an error.
- *A second `done`*: the text is appended to `resolutionText` (separated by a rule line), `resolvedAt` moves, the status stays `done`, and each resolution is delivered. A resolution never reopens an item.
- *`done` on a `question` with empty text*: refused (400).
- *Scope defaults.* Agent `create_todo`: `scope` is optional and defaults to `session`. Human `POST /api/todos`: defaults to `session` when the request carries `sessionId` (the per-session panel) and to `global` when it does not (the global page). An explicit `scope` always wins. The only invalid combination is a question with `scope = global` (refused, 400 and a CHECK): a question whose session is gone has nobody to hear the answer.
- *Session delete, by scope (kind no longer affects deletion):* open `session`-scoped items of the deleted session become `withdrawn`, a terminal status distinct from `dismissed`. The rows are KEPT, because "ended unanswered / undone" is the count this feature exists to make possible and a hard delete would destroy it. `global` items are untouched whatever their status; their `sessionId` stays as provenance. Non-open rows of the deleted session (done, superseded, dismissed) stay as they are. One `UPDATE todos SET status = 'withdrawn', updated_at = ? WHERE session_id = ? AND scope = 'session' AND status = 'open'` runs in the session-deletion transaction, and on the path without an injected database handle right after the row delete. Deleting a session that has no items is a no-op.
- *A global item created by a deleted session* stays open with its `sessionId`.
- *Re-scoping.* A human may `PATCH` the `scope` of an OPEN `action` only, in both directions. `session` to `global` keeps `sessionId`. `global` to `session` needs a `sessionId` (the stored provenance, or one passed in the same PATCH) and is refused otherwise. A `question` cannot be re-scoped, a non-open item cannot be re-scoped, and agents cannot re-scope (a human act, like resolve and delete).
- *What the notification carries.* Only a resolution of an agent-created item is delivered, and the text is THIS resolution's text (not the appended history), truncated to 500 characters with an ASCII `...` marker because the line is injected as typed input; an `action` resolved without text carries an empty `resolution`. The full text stays in `list_todos`. Dismiss, delete, supersede and withdraw deliver nothing: they are not an answer. The creating session learns of a dismissed, superseded or withdrawn item through `list_todos`; a deleted item is gone (delete is a hard delete), so nothing, including `list_todos`, reports it afterwards.
- *Agent resolution (v2).* `resolve_todo` accepts only OPEN items whose `sessionId` is the caller's session (either creator), only to `done`. It is atomic: every id must be such an item or the whole call is refused and nothing is written (one transaction, like `supersedes`); duplicate ids are deduplicated; an empty or longer-than-50 list, a whitespace-only `statement` and an unknown `statedBy` are refused. It delivers NO notification (the resolving session is the item's own session and already knows) and emits one `todos-updated`; human resolutions deliver as before. The server cannot verify the quote: the words a human types into a terminal agent go through PTY stdin, which the server forwards and never records, so the quote is agent-reported and the record distinguishes it from a human's own resolution (`resolvedByWorkerId`) so a human can audit. Adoption of an item by a successor session (#2134) rewrites `session_id`, after which this same rule makes the item resolvable by the successor.
- *Resolving an item whose creating worker is gone*: the resolution is stored and the delivery failure is recorded; the status is `done` either way (storage is the record, delivery is best effort).

**Who may do what.** A team tool, like the memo and End Session: any team member may create, assign, resolve, dismiss and DELETE an item. Delete is a hard delete in v1; the audit case is the `dismissed` row, which stays. Agents may create, list and supersede their own session's items, and (v2) may mark their own session's OPEN items `done` with `resolve_todo` on the strength of a human's quoted words (rules below); agents may NOT dismiss or delete, and may not complete an item they performed themselves (an `action` is by definition a human act: if the agent did it, the item was mis-filed). Multi-user visibility: every team member sees every item, consistent with memos today.

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
-- migration v50: human TODO list
CREATE TABLE IF NOT EXISTS todos (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  scope                TEXT NOT NULL,
  title                TEXT NOT NULL,
  body                 TEXT NOT NULL,
  session_id           TEXT,              -- the item's session; required for scope='session' and for an agent creator; provenance otherwise. No FK: rows outlive the session
  created_worker_id    TEXT,              -- agent creator (the resolution notification's target)
  created_user_id      TEXT,              -- human creator
  assignee_user_id     TEXT,              -- null = anyone on the team
  status               TEXT NOT NULL DEFAULT 'open',
  resolution_text      TEXT,
  resolved_by_user_id  TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CONSTRAINT todos_kind_check           CHECK (kind IN ('question', 'action')),
  CONSTRAINT todos_scope_check          CHECK (scope IN ('session', 'global')),
  CONSTRAINT todos_status_check         CHECK (status IN ('open', 'done', 'superseded', 'dismissed', 'withdrawn')),
  CONSTRAINT todos_creator_check        CHECK ((created_worker_id IS NOT NULL AND created_user_id IS NULL) OR (created_worker_id IS NULL AND created_user_id IS NOT NULL)),
  CONSTRAINT todos_agent_session_check  CHECK (created_worker_id IS NULL OR session_id IS NOT NULL),
  CONSTRAINT todos_session_scope_check  CHECK (scope <> 'session' OR session_id IS NOT NULL),
  CONSTRAINT todos_question_scope_check CHECK (kind <> 'question' OR scope = 'session')
);
CREATE INDEX IF NOT EXISTS idx_todos_status_assignee ON todos (status, assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_todos_session_status  ON todos (session_id, status);
```

Owner approval: 2026-10-15, as written above (scope revision included). `LATEST_SCHEMA_VERSION` was 49 at `ee176a3e`, so v50 is the next free version. Notes: the `CHECK` constraints follow `mcp_server_permissions_decision_check` (`database/connection.ts:2869`); the table is additive, following the `migrateToV33` shape. There is **no foreign key** on `session_id` (a row must outlive the session, as in `timers` and `bookmarks`) and none on the user columns either (a row must outlive everything it references; users are never deleted today).


### v51 (v2): agent-recorded resolutions

```sql
-- migration v51: agent-recorded resolutions (human TODO list v2)
ALTER TABLE todos ADD COLUMN resolved_by_worker_id TEXT;  -- agent worker that recorded a human's statement; NULL when a human resolved the item in the UI
```

One additive column, no `CHECK` (the invariant "set only with status `done`" is enforced in the repository and pinned by a test), `LATEST_SCHEMA_VERSION` 50 -> 51. Owner approval: 2026-10-16, as written above. Wire: `Todo` gains `resolvedByWorkerId: string | null` in `types/todo.ts` and `schemas/todo.ts` (strictObject, so both or the frame is dropped): one `SCHEMA_VERSION` move for the whole of v2.

## 4. Surfaces (v1)

**MCP, for agents** (a session-claiming pair: `create_todo` and `list_todos` join `SESSION_CLAIMING_TOOLS`, `mcp/session-claiming-tools.ts:11`, and gate the claimed `sessionId` through `checkCallerOwnsSession`, like `create_conditional_wakeup`; a terminal agent passes its own session and worker ids, an embedded agent defaults to its own):

- `create_todo({ kind, scope?, title, body, assigneeUsername?, supersedes? }) -> { id }`. Appends an `open` item. `assigneeUsername` is resolved to a user id server-side. `supersedes` names an open item of the same session and marks it `superseded` in the same transaction. A second call never overwrites the first.
- `resolve_todo({ ids: string[] (1..50), statement, statedBy?, sessionId?, workerId? }) -> { todos }` (v2). Marks open items of THIS session done on the strength of a human's words: `statement` is the human's words, quoted (what they typed or said), never a resolution inferred from what they did. One call covers several items one statement answered (the owner's three merges, one "all OK"). Session-claiming (it joins `SESSION_CLAIMING_TOOLS`, identity as `create_todo`). `resolvedByUserId` = the `statedBy` user, else the session's creator, else null; `resolvedByWorkerId` = the caller. Rules in section 2.
- `list_todos({ status?, scope?, mine? })`: the session's own items; `mine` means assigned to this session's user. This is also how an agent catches up when a notification could not be delivered (except for a hard-deleted item, which nothing reports).

**REST, for the UI** (server-composed; the client renders only what these return, invariant N1 of `docs/design/notification-center.md`):

- `GET /api/todos?status=&scope=&assignee=&sessionId=`.
- `POST /api/todos` (human create: kind, scope?, title, body, sessionId?, assignee).
- `PATCH /api/todos/:id` (`assigneeUserId`, `title`, `body`, `scope`, `sessionId`, for open items; re-scoping rules in section 2).
- `POST` and `PATCH` both return 404 when the `sessionId` names no live or persisted (paused) session, or the `assigneeUserId` names no user; the 400 refusals run first.
- `POST /api/todos/:id/resolve { text? }`, `POST /api/todos/:id/dismiss`, `DELETE /api/todos/:id`.

Authorization is the team-tool rule of section 2 (any member), not `assertCanOperateSession`; the MCP tools are the only path that checks session ownership, because that is the only path with a claimed session.

**UI.**

- (a) A per-session block beside `MemoPanel`: "To-do (N)", N = the open items of this session (both scopes, with a scope badge), listing every item whose `sessionId` is this session; zero open items hides the block. (v2: (e1) UI: status changes, create and assign from the session sidebar, and a per-item detail view -- shape per the owner's decision recorded in #2136; specified there, not here, until it lands.)
- (b) A **global `/todos` page** (a new route beside `routes/artifacts`, `routes/jobs`): all items, filters for status, assignee and session. This is what makes assignment usable: an assignee cannot find items session by session. It also hosts the human "add" and "delete" controls. The page refetches on `todos-updated` and on `session-deleted`; the server emits no `todos-updated` for a deletion's withdrawals, `session-deleted` is that signal.
- (c) A **navigation badge** = the open items assigned to me, in the header navigation (`components/header/NavLinks.tsx`, `MobileNavMenu.tsx`).
- The body renders with the same markdown renderer as the memo (`react-markdown`, `MemoPanel.tsx:2`; the shared fenced-block chrome is `MarkdownCodeBlock`: a Copy control on every block, plus a Run control on ```terminal blocks only that opens a full-command confirmation and then sends the text to a terminal worker of the session, #2085 / #2100), so #2085's command block lands once, for both.
- Assignment needs a **user directory**: `UserRepository` has `findById` but no list method, and no users API exists, so slice (b) adds `UserRepository.findAll()` and `GET /api/users` ({ id, username }); usernames are already visible to every member through `Session.createdByUsername`. In single-user mode there is one user and the assignment control is hidden.

**Delivery of the resolution.** Resolving stores the resolution, then notifies the creating worker through `SessionManager.deliverWorkerNotification(sessionId, workerId, params)` (`services/session-manager.ts:959`), the seam inbound events and timers use, so the agent hears "item X resolved: <text>" as a turn whether it was a question or an action. The notification needs ONE new kind: `PTY_NOTIFICATION_KINDS` (`packages/shared/src/types/system-events.ts:74`) gains `internal-todo-resolved`, with its interface in `lib/pty-notification.ts`. Because that list is read at runtime by the embedded-agent schema's picklist, adding it **moves `SCHEMA_VERSION`** even though no schema file's text changes (the picklist-source rule in `.claude/rules/pre-pr-completeness.md` Q10). Delivery is best effort and returns a structured failure reason (`WorkerNotificationResult`). A human-created item has no worker to notify. The kind is added in slice (a) and unused until slice (c).

**Realtime.** A trigger-only `todos-updated { type, sessionId }` app message (`sessionId` nullable) tells clients to refetch (N1). Do not copy `memo-updated`, which carries `content` (`schemas/app-server-message.ts:406`): it predates N1. The protocol-dispatch fixture rule applies at implementation. **Wire summary:** the `Todo` type and schema pair (`types/todo.ts`: `TODO_KINDS`, `TODO_SCOPES`, `TODO_STATUSES`; `schemas/todo.ts`: `TodoSchema`, `CreateTodoRequestSchema`, `UpdateTodoRequestSchema`, `ResolveTodoRequestSchema`), the new notification kind and `todos-updated` are all client-reaching; one owner decision covers the DDL and the wire, and all of them land in slice (a) so the todo wire shapes move `SCHEMA_VERSION` once. Slice (b) moves it a second time for the response schema of the new user directory endpoint; slice (c) moves nothing.

## 5. What changes for the Orchestrator skill

v2: when the human answers in chat or in a message, the Orchestrator records it with `resolve_todo` (the human's words quoted) before acting on the answer; the `/todos` answer path stays for the human's convenience, not as the only one.

The memo keeps status; the list takes requests. Owner-facing questions AND owner-facing commands go through `create_todo`, and the answer or the confirmation arrives as a notification (or through `list_todos`, except for a hard-deleted item, which nothing reports). The skill text changed in slice (c): the memo keeps status, owner-facing questions and commands go through `create_todo`, an owner-gated wait is an open `question` item, and the handoff memo lists each open item by title and todo id. `list_todos` is scoped to the calling session, so a successor session finds the predecessor's items on the global `/todos` page (and by id), not through `list_todos`; the common case is the SAME session surviving a context refresh or restart, where `list_todos({ status: 'open' })` is the catch-up.

## 6. Non-goals (v1)

Due dates, priority, comments or threads, Slack or webhook delivery, cross-repository scoping, per-item access control, time-based automatic expiry. Not in v2 either: agent dismiss (`dismissed` is the human's "not needed" count; an agent that no longer needs its question uses `supersedes` or asks the human), agent self-performed completion, a third kind for approvals ("may I merge X?" is a `question` answered "yes"; approval is a body shape, not a kind), and server-side verification of quoted words (no input record exists).

## 7. Implementation slices (sequential; each `Refs #2080`, the last `Closes #2080`)

- **(a)** Migration v50, repository, REST, MCP `create_todo` / `list_todos`, the per-session panel, `todos-updated`, the scope-based withdraw rule in the session-deletion transaction (it is the owner's design point), and ALL wire shapes including the `internal-todo-resolved` notification kind.
- **(b)** The global `/todos` page, assignment (`PATCH`, the user directory), the navigation badge, human create, re-scope and delete.
- **(c)** The resolution delivery through `deliverWorkerNotification` and the Orchestrator skill text (applied; no `SCHEMA_VERSION` move, the notification kind was added in (a)).
- **(d)** (v2) Migration v51 and the wire field `resolvedByWorkerId` (the one `SCHEMA_VERSION` move of v2), the repository `resolve` taking the worker and the transactional `resolveManyOpen`, the MCP `resolve_todo`, and the skill text; the provenance line ("resolved by <user>" vs "recorded by an agent from <user>'s statement") renders in the to-do UI once its detail view lands. Joins the next reload batch.
- **(e1)** (v2) UI: status changes, create and assign from the session sidebar, and a per-item detail view -- shape per the owner's decision recorded in #2136; specified there, not here, until it lands.

[#2085](https://github.com/ms2sato/agent-console/issues/2085) (the command block in a body) rides after slice (a) as its own Issue, shared with the memo renderer. Polarity each slice must carry, against today: a memo overwrite leaves the list intact; a second `create_todo` does not overwrite the first; the resolution reaches the creating session as a notification; a session deletion withdraws its open `session`-scoped items and leaves its `global` items open.
