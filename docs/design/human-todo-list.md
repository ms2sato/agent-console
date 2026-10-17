# Human TODO List: stable, countable items for the humans (questions and actions)

Status: implemented (slice (a) #2120, slice (b) #2129, slice (c) #2133, the closing slice); owner-approved DDL (2026-10-15). Issue [#739](https://github.com/ms2sato/agent-console/issues/739); implementation [#2080](https://github.com/ms2sato/agent-console/issues/2080). The storage change needs a database migration and the feature adds wire types, both the owner's call; the document's job is to make that a one-line yes or no.

Every claim about the code below was read at `origin/main` **`f083ef62`** and is cited as `file:line` at that SHA.

## History

v2 (2026-10-16): agent-recorded resolutions and status changes from the session sidebar, from the owner's dogfood: an agent asked three "may I merge X?" questions, the human answered "all OK to merge" in chat, the agent merged but could not close the items, so the record diverged from reality; and the sidebar could not change status. Sections below carry the v2 changes inline and mark them.

v3 (2026-10-17): activities on an item, from the owner's two cases: pushing back on an agent's question without closing it (a reply thread the agent hears), and moving an item to another session on a human's instruction (an agent takes over another user's item only with the human's quoted words). Sections below mark the v3 changes inline.

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

**Activities (v3).** An item has an ordered list of activities of two kinds, stored in two tables and shown as one timeline ordered by `created_at`, then `kind`, then `id` in the database (the sort belongs to the query, and a later pagination needs a single ordered query): a `comment` is words left on the item by a human (UI) or by an agent of the item's session (MCP), the status unchanged; a `moved` row records every change of the item's session (the human move, `adopt_todo`), carrying `from` and `to` and, when an agent moved the item on a human's instruction, the quoted `statement` and the attributed user. Rules: a comment is allowed on `open` and `done` items only (a `superseded`, `dismissed` or `withdrawn` item takes none: 409); an agent comments only on items of its own session (the `resolve_todo` rule); a human comment on an agent-created item is delivered to the creating worker as `[internal:todo-comment]`, an agent comment is delivered to nobody (the human reads the detail); activities are deleted with their item (foreign keys with `ON DELETE CASCADE`, the one departure from this table's "no foreign keys": a todo outlives its session, a comment or a move has no reason to outlive its item) and are kept through a session deletion; a `moved` row is written when, and only when, `session_id` changes, with `statement` NULL when no words were given; a same-session call that re-targets only the delivery worker updates the row and writes no activity (a move from a session to itself would say nothing), and a same-session, same-worker call is a read-only no-op. Boundaries: zero activities means no Thread section; the comment text is capped at 4000 characters in the request and 500 in the delivered line (like the resolution notification).

**Who may do what.** A team tool, like the memo and End Session: any team member may create, assign, resolve, dismiss and DELETE an item. Delete is a hard delete in v1; the audit case is the `dismissed` row, which stays. Agents may create, list and supersede their own session's items, and (v2) may mark their own session's OPEN items `done` with `resolve_todo` on the strength of a human's quoted words (rules below); agents may NOT dismiss or delete, and may not complete an item they performed themselves (an `action` is by definition a human act: if the agent did it, the item was mis-filed). Multi-user visibility: every team member sees every item, consistent with memos today. (v3) An agent may take over an item of a session owned by another user only with the human's quoted instruction (`statement`), recorded as a `moved` activity; a silent takeover stays refused.

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

### v52 (v3): activities

```sql
-- migration v52: Todo activities (human TODO list v3) -- two tables, one timeline
CREATE TABLE IF NOT EXISTS todo_comments (
  id              TEXT PRIMARY KEY,
  todo_id         TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  actor_user_id   TEXT,                      -- a human replied in the UI
  actor_worker_id TEXT,                      -- an agent of the item's session replied through MCP
  text            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CONSTRAINT todo_comments_actor_check CHECK ((actor_user_id IS NOT NULL AND actor_worker_id IS NULL) OR (actor_user_id IS NULL AND actor_worker_id IS NOT NULL)),
  CONSTRAINT todo_comments_text_check  CHECK (length(text) > 0)
);
CREATE INDEX IF NOT EXISTS idx_todo_comments_todo_created ON todo_comments (todo_id, created_at);

CREATE TABLE IF NOT EXISTS todo_moves (
  id                 TEXT PRIMARY KEY,
  todo_id            TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  actor_user_id      TEXT,                   -- a human moved it (the (e1)-b route)
  actor_worker_id    TEXT,                   -- an agent adopted it through MCP
  from_session_id    TEXT,                   -- NULL when the item was global
  to_session_id      TEXT NOT NULL,
  statement          TEXT,                   -- the human's quoted instruction; NULL when none was given
  attributed_user_id TEXT,                   -- statedBy: whose words `statement` is; NULL when not attributed
  created_at         TEXT NOT NULL,
  CONSTRAINT todo_moves_actor_check       CHECK ((actor_user_id IS NOT NULL AND actor_worker_id IS NULL) OR (actor_user_id IS NULL AND actor_worker_id IS NOT NULL)),
  CONSTRAINT todo_moves_statement_check   CHECK (statement IS NULL OR length(statement) > 0),
  CONSTRAINT todo_moves_attribution_check CHECK (attributed_user_id IS NULL OR statement IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_todo_moves_todo_created ON todo_moves (todo_id, created_at);
PRAGMA user_version = 52;
```

`LATEST_SCHEMA_VERSION` 51 -> 52. Owner approval: 2026-10-17, as written above (the two-table revision, via the Todo list). The rule "an agent moving an item of ANOTHER user's session needs a `statement`" involves the todo's owner and cannot live in the table; it stays in the MCP handler. Wire: `TodoActivity` is a discriminated union on `kind` (`TodoCommentActivity` | `TodoMoveActivity`), `Todo` gains `commentCount`, the detail response is `{ todo, activities }`, and the notification kind `internal-todo-comment` is added: one `SCHEMA_VERSION` move.

## 4. Surfaces (v1)

**MCP, for agents** (a session-claiming pair: `create_todo` and `list_todos` join `SESSION_CLAIMING_TOOLS`, `mcp/session-claiming-tools.ts:11`, and gate the claimed `sessionId` through `checkCallerOwnsSession`, like `create_conditional_wakeup`; a terminal agent passes its own session and worker ids, an embedded agent defaults to its own):

- `create_todo({ kind, scope?, title, body, assigneeUsername?, supersedes? }) -> { id }`. Appends an `open` item. `assigneeUsername` is resolved to a user id server-side. `supersedes` names an open item of the same session and marks it `superseded` in the same transaction. A second call never overwrites the first.
- `adopt_todo({ id, sessionId?, workerId? }) -> { todo }` (v2). A successor session takes over an OPEN item by re-targeting it to itself, so the `[internal:todo-resolved]` delivery reaches the live session. **Decision: adoption re-targets the delivery, not just the row.** `deliverTodoResolution` sends to the item's `sessionId` AND to its creating worker, so moving only `session_id` would still deliver to the dead predecessor worker; adoption therefore writes `session_id` = the caller's session and, for an agent-created item, `created_worker_id` = the caller's worker. A human-created item keeps its creator (the `CHECK` on the creator columns forbids both being set, and human items deliver nothing today). Scope, status and text are untouched; only OPEN items are adoptable; adopting an item that is already the caller's session's is a no-op success (a successor re-running the handoff step must not fail); an item whose session is owned by another user (live or persisted) is refused; when the creating session no longer exists, or the caller has no token identity, that check cannot run and adoption proceeds. It delivers no notification (adoption is not a resolution) and emits `todos-updated` for the old and the new session. Session-claiming, identity as `create_todo`; (v3) `adopt_todo` also takes `statement?` (the human's words instructing the move, quoted; REQUIRED to take over an item of a session owned by another user, otherwise the refusal says to pass it) and `statedBy?` (a username, resolved like `resolve_todo`'s, unknown refused); every successful adopt that changes the session records a `moved` activity, with `statement` NULL when none was given. `statedBy` names whose words `statement` is, so it needs a `statement`; an omitted `statedBy` is recorded as unattributed (NULL, "not stated"), NOT defaulted to the session's owner as `resolve_todo` defaults its resolver: a resolution must have a resolver, but an attribution is the provenance of a quote, and a defaulted quote author would be fabricated provenance. The adopting worker must be able to receive notifications (agent, terminal or embedded-agent; a git-diff worker cannot), like `create_todo`'s creating worker, because it becomes the delivery target.
- `comment_todo({ id, text, sessionId?, workerId? }) -> { todo, activities }` (v3). An agent replies on an item of ITS OWN session, open or done; session-claiming, identity and gate as `resolve_todo`; refused for an unknown item, another session's item, a `superseded` / `dismissed` / `withdrawn` item and a whitespace-only text; delivers nothing (the human reads the detail). `list_todos` items carry their `activities`.
- `resolve_todo({ ids: string[] (1..50), statement, statedBy?, sessionId?, workerId? }) -> { todos }` (v2). Marks open items of THIS session done on the strength of a human's words: `statement` is the human's words, quoted (what they typed or said), never a resolution inferred from what they did. One call covers several items one statement answered (the owner's three merges, one "all OK"). Session-claiming (it joins `SESSION_CLAIMING_TOOLS`, identity as `create_todo`). `resolvedByUserId` = the `statedBy` user, else the session's creator, else null; `resolvedByWorkerId` = the caller. Rules in section 2.
- `list_todos({ status?, scope?, mine?, global? })`: the session's own items; `mine` means assigned to this session's user. `global: true` (v2) drops the session filter and lists every `scope = 'global'` item of every session, so a successor Orchestrator can catch up on its predecessor; session-scoped items stay private to their session, and `global: true` combined with `scope: 'session'` is refused. **Decision: the listing is team-wide, like REST** (`GET /api/todos?scope=global` already shows every member the same set, no user filter, and section 2 says every team member sees every item); it is deliberately NOT restricted to the caller's user, because an owner join on `sessions` would hide exactly the handoff case, a global item whose creating session was deleted has no session row to join. This is also how an agent catches up when a notification could not be delivered (except for a hard-deleted item, which nothing reports).

**REST, for the UI** (server-composed; the client renders only what these return, invariant N1 of `docs/design/notification-center.md`):

- `GET /api/todos?status=&scope=&assignee=&sessionId=`.
- `POST /api/todos` (human create: kind, scope?, title, body, sessionId?, assignee).
- `PATCH /api/todos/:id` (`assigneeUserId`, `title`, `body`, `scope`, `sessionId`, for open items; re-scoping rules in section 2).
- `POST` and `PATCH` both return 404 when the `sessionId` names no live or persisted (paused) session, or the `assigneeUserId` names no user; the 400 refusals run first.
- `GET /api/todos/:id` (one item as `{ todo, activities }` (v3); 404 `Todo not found` when absent), `POST /api/todos/:id/comments { text }` (v3; 404 unknown, 409 unless `open` or `done`, 400 empty or over 4000 characters; responds `{ todo, activities }`).
- `POST /api/todos/:id/resolve { text? }`, `POST /api/todos/:id/dismiss`, `DELETE /api/todos/:id`.

Authorization is the team-tool rule of section 2 (any member), not `assertCanOperateSession`; the MCP tools are the only path that checks session ownership, because that is the only path with a claimed session.

**UI.**

- (a) A per-session block beside `MemoPanel`: "Todo (N)", N = the open items of this session (both scopes, with a scope badge), listing every item whose `sessionId` is this session as a summary row (see "Surfaces" below). The block renders with zero items too, so a session with no Todo can still get one from its sidebar (v2 behaviour change: it was hidden at zero open items). The block renders once the first fetch settles, including on error.
- (b) A **global `/todos` page** (a new route beside `routes/artifacts`, `routes/jobs`): all items, filters for status, assignee and session. This is what makes assignment usable: an assignee cannot find items session by session. It also hosts the human "add" control; delete, edit and re-scope live in the detail view (see "Surfaces"). The page refetches on `todos-updated` and on `session-deleted`; the server emits no `todos-updated` for a deletion's withdrawals, `session-deleted` is that signal.
- (c) A **navigation badge** = the open items assigned to me, in the header navigation (`components/header/NavLinks.tsx`, `MobileNavMenu.tsx`).
- The body renders with the same markdown renderer as the memo (`react-markdown`, `MemoPanel.tsx:2`; the shared fenced-block chrome is `MarkdownCodeBlock`: a Copy control on every block, plus a Run control on ```terminal blocks only that opens a full-command confirmation and then sends the text to a terminal worker of the session, #2085 / #2100), so #2085's command block lands once, for both.
- Assignment needs a **user directory**: `UserRepository` has `findById` but no list method, and no users API exists, so slice (b) adds `UserRepository.findAll()` and `GET /api/users` ({ id, username }); usernames are already visible to every member through `Session.createdByUsername`. In single-user mode there is one user and the assignment control is hidden.

**Surfaces (decision table, owner-confirmed 2026-10-16 for the sidebar cells; the detail-view cells owner-confirmed 2026-10-17 "as recommended").** Rows are operations, columns are surfaces; every cell is decided.

| operation | session sidebar (`SessionTodosPanel`) | `/todos` list (`TodosPage`) | detail (`TodoDetail`: page `/todos/:id` and in-session dialog) | MCP | REST |
|---|---|---|---|---|---|
| create | do: session-scoped create only (narrowing pending owner confirmation, Refs #2136); a global item is created on /todos or re-scoped from the detail | do: `AddTodoForm` | not here: a detail is one item | do: `create_todo` | do: POST |
| list / summary | do: `TodoRow` summary | do: `TodoRow` summary + filters | not here | do: `list_todos`; `global: true` also lists every session's global items (team-wide, like REST; session-scoped items stay private) | do: GET; `scope=global` lists the global ones |
| read detail (full body, resolution history, provenance, timestamps, session link) | not here: summary only; "Open" opens the dialog | not here: "Open" links to the page | do | do: `list_todos` carries the full item | do: GET /:id |
| resolve | do | do | do | do: `resolve_todo` | do: POST /:id/resolve |
| dismiss | do | do | do | not here: the human's "not needed" count | do: POST /:id/dismiss |
| assign / reassign | do: select on the summary row | do | do | not here: at create only | do: PATCH |
| edit title / body | not here: lives in the detail | not here: lives in the detail | do | not here (v1) | do: PATCH |
| re-scope | not here: lives in the detail | not here: lives in the detail | do: open items only | not here (v1) | do: PATCH |
| delete | not here | not here: lives in the detail | do: `ConfirmDialog` | not here (v1) | do: DELETE |
| run a ```terminal block | not here: the body is in the detail | not here | do in the in-session dialog only; on the page the block shows Copy + "Open in session" | n/a | n/a |
| adopt / supersede | not here | not here | not here | do: `adopt_todo` (re-target an open item to the caller's session and worker; an item of a session owned by another user is refused) / `create_todo { supersedes }` | not here: the human form is "human move to another session" below |
| human move to another session | later: (e1)-b, Refs #2136 | later: (e1)-b | later: (e1)-b | not here | later: (e1)-b |
| default view "mine + shared" | n/a: per session | later: (e1)-b | n/a | not here | later: (e1)-b |
| comment / reply (v3) | not here: the summary row ("Open" reaches the detail; a row-level shortcut is decided `not here`, flagged for the owner) | not here | do: Thread section, Reply on `open` and `done` | do: `comment_todo` (own session, `open` or `done`) | do: POST /:id/comments |
| read the thread (v3) | not here: an "N replies" chip only | not here: chip only | do | do: `list_todos` items carry `activities` | do: GET /:id |
| human notice of an agent's reply (v3) | do: chip count on the row | do: chip | do | n/a | n/a; notification-center entry: later: [#2159](https://github.com/ms2sato/agent-console/issues/2159) |
| move on a human's instruction, by an agent (v3) | not here | not here | not here | do: `adopt_todo { statement, statedBy (optional) }`; a silent takeover of another user's item is refused | not here: the human form is the move route of (e1)-b |
| thread pagination (v3) | n/a | n/a | later: [#2160](https://github.com/ms2sato/agent-console/issues/2160) | n/a | later: [#2160](https://github.com/ms2sato/agent-console/issues/2160) |

**Detail view.** The page `/todos/:id` is the identity of an item (linkable, survives a reload); the in-session dialog is the convenience that opens the same `TodoDetail` over the session without leaving the terminal. Rows are summary-only (title, badges, who created and who is assigned, resolve / dismiss / assign) and both hosts render one `TodoRow` component, so the sidebar and the page cannot drift. The body, the resolution history with its provenance line, edit, re-scope and delete live only in the detail. Run on a ```terminal block is offered only where a terminal of the item's session is in reach (the dialog); the page shows Copy and an "Open in session" link instead. A detail refetches on every `todos-updated` frame (a re-scope moves an item between sessions, so a frame naming the old session is still about this item); a deleted item renders a "deleted or does not exist" state with a link back to the list, not the generic error fallback.

**Thread (v3).** Between the Body and the Resolution the detail shows one timeline, ordered by the database (`created_at`, then `kind`, then `id`; the client does not sort, and a long thread will paginate on that same key, later: [#2160](https://github.com/ms2sato/agent-console/issues/2160)). A comment row shows its author (a human's username, "agent" for a worker) and time with the text; a move row shows "Moved from <session> to <session> by <actor>" and, when a statement is recorded, the quoted words ("on a human's instruction: ..." when unattributed; with the attributed user's name when attributed). A session is shown as its 8-character id until (e1)-b brings the live-session titles into the detail (the item's own session is a raw id there today). An `open` or `done` item also shows a Reply input; other statuses show none. The rows and the sidebar show an "N replies" chip when `commentCount` is above zero (comments only, never moves).

**Delivery of the resolution.** Resolving stores the resolution, then notifies the creating worker through `SessionManager.deliverWorkerNotification(sessionId, workerId, params)` (`services/session-manager.ts:959`), the seam inbound events and timers use, so the agent hears "item X resolved: <text>" as a turn whether it was a question or an action. The notification needs ONE new kind: `PTY_NOTIFICATION_KINDS` (`packages/shared/src/types/system-events.ts:74`) gains `internal-todo-resolved`, with its interface in `lib/pty-notification.ts`. Because that list is read at runtime by the embedded-agent schema's picklist, adding it **moves `SCHEMA_VERSION`** even though no schema file's text changes (the picklist-source rule in `.claude/rules/pre-pr-completeness.md` Q10). Delivery is best effort and returns a structured failure reason (`WorkerNotificationResult`). A human-created item has no worker to notify. The kind is added in slice (a) and unused until slice (c).

**Realtime.** A trigger-only `todos-updated { type, sessionId }` app message (`sessionId` nullable) tells clients to refetch (N1). Do not copy `memo-updated`, which carries `content` (`schemas/app-server-message.ts:406`): it predates N1. The protocol-dispatch fixture rule applies at implementation. **Wire summary:** the `Todo` type and schema pair (`types/todo.ts`: `TODO_KINDS`, `TODO_SCOPES`, `TODO_STATUSES`; `schemas/todo.ts`: `TodoSchema`, `CreateTodoRequestSchema`, `UpdateTodoRequestSchema`, `ResolveTodoRequestSchema`), the new notification kind and `todos-updated` are all client-reaching; one owner decision covers the DDL and the wire, and all of them land in slice (a) so the todo wire shapes move `SCHEMA_VERSION` once. Slice (b) moves it a second time for the response schema of the new user directory endpoint; slice (c) moves nothing.

## 5. What changes for the Orchestrator skill

v2: when the human answers in chat or in a message, the Orchestrator records it with `resolve_todo` (the human's words quoted) before acting on the answer; the `/todos` answer path stays for the human's convenience, not as the only one.

The memo keeps status; the list takes requests. Owner-facing questions AND owner-facing commands go through `create_todo`, and the answer or the confirmation arrives as a notification (or through `list_todos`, except for a hard-deleted item, which nothing reports). The skill text changed in slice (c): the memo keeps status, owner-facing questions and commands go through `create_todo`, an owner-gated wait is an open `question` item, and the handoff memo lists each open item by title and todo id. `list_todos` is scoped to the calling session by default, and v2 adds the opt-in `global: true` for the handoff: a successor session runs `list_todos({ global: true, status: 'open' })` and takes each item it inherits with `adopt_todo` (session-scoped open items of the predecessor are adopted by the ids the memo lists), while the memo's title-and-id listing and the global `/todos` page, where the full text stays, remain the fallback; the common case is still the SAME session surviving a context refresh or restart, where `list_todos({ status: 'open' })` is the catch-up.

v3: if the owner replies on the item instead of answering, the agent hears `[internal:todo-comment]` and answers on the same item with `comment_todo` (or with `create_todo { supersedes }` when the question itself changes); to take over another user's item on the owner's instruction it passes their words as `statement` to `adopt_todo`.

## 6. Non-goals (v1)

Due dates, priority, Slack or webhook delivery, cross-repository scoping, per-item access control, time-based automatic expiry. Not in v2 either: agent dismiss (`dismissed` is the human's "not needed" count; an agent that no longer needs its question uses `supersedes` or asks the human), agent self-performed completion, a third kind for approvals ("may I merge X?" is a `question` answered "yes"; approval is a body shape, not a kind), and server-side verification of quoted words (no input record exists). Not in v3 either: editing or deleting a comment; a notification-center entry for an agent's comment ([#2159](https://github.com/ms2sato/agent-console/issues/2159)); pagination of a long thread ([#2160](https://github.com/ms2sato/agent-console/issues/2160)); comments on `superseded`, `dismissed` or `withdrawn` items.

## 7. Implementation slices (sequential; each `Refs #2080`, the last `Closes #2080`)

- **(a)** Migration v50, repository, REST, MCP `create_todo` / `list_todos`, the per-session panel, `todos-updated`, the scope-based withdraw rule in the session-deletion transaction (it is the owner's design point), and ALL wire shapes including the `internal-todo-resolved` notification kind.
- **(b)** The global `/todos` page, assignment (`PATCH`, the user directory), the navigation badge, human create, re-scope and delete.
- **(c)** The resolution delivery through `deliverWorkerNotification` and the Orchestrator skill text (applied; no `SCHEMA_VERSION` move, the notification kind was added in (a)).
- **(d)** (v2) Migration v51 and the wire field `resolvedByWorkerId` (the one `SCHEMA_VERSION` move of v2), the repository `resolve` taking the worker and the transactional `resolveManyOpen`, the MCP `resolve_todo`, and the skill text; the provenance line ("resolved by <user>" vs "recorded by an agent from <user>'s statement") renders in the Todo detail view (slice (e1)). Joins the next reload batch.
- **(f)** (v2) Successor listing and adoption: `list_todos({ global: true })` and `adopt_todo` (no `SCHEMA_VERSION` move, no client change), the handoff text in the skill. Closes #2134.
- **(g)** (v3) Activities: migration v52 (`todo_comments`, `todo_moves`), the shared `TodoActivity` union and `commentCount`, `comment_todo`, `adopt_todo`'s `statement` / `statedBy`, `POST /api/todos/:id/comments`, the `internal-todo-comment` notification kind, and the Thread, Reply and reply-chip UI. One `SCHEMA_VERSION` move. Closes #2155.
- **(e1)-a** (v2) UI, delivered: the "Todo" label, `GET /api/todos/:id`, summary rows shared by the sidebar and the `/todos` page, the detail view (page `/todos/:id` and the in-session dialog), and create / assign / resolve / dismiss from the session sidebar. No `SCHEMA_VERSION` move (the detail reuses `TodoResponseSchema`). The human move route and the "mine + shared" default view are (e1)-b, not yet specified here.

[#2085](https://github.com/ms2sato/agent-console/issues/2085) (the command block in a body) rides after slice (a) as its own Issue, shared with the memo renderer. Polarity each slice must carry, against today: a memo overwrite leaves the list intact; a second `create_todo` does not overwrite the first; the resolution reaches the creating session as a notification; a session deletion withdraws its open `session`-scoped items and leaves its `global` items open.
