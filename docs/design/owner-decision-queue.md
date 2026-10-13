# Owner-Decision Queue: stable, countable questions from a session to its owner

Status: design proposal (not implemented). Issue [#739](https://github.com/ms2sato/agent-console/issues/739). The storage choice needs a database migration, which is the owner's call; the document's job is to make that a one-line yes or no.

Every claim about the code below was read at `origin/main` **`ac2d6c83`** and is cited as `file:line` at that SHA.

## 1. Problem

An Orchestrator session that needs the owner's judgment today carries the question in its session memo. The carrier is `write_memo` (`packages/server/src/mcp/mcp-server.ts:1503`), which calls `MemoService.writeMemo(sessionId, content, resolver)` (`services/memo-service.ts:37`): a whole-file overwrite of `<memos dir>/<sessionId>.md` (write to a temp file, rename over the old one), rendered by `components/sessions/MemoPanel.tsx`. As questions pile up, four things go wrong, all structural:

- **No count.** The number of unanswered questions is not knowable without reading the whole memo.
- **No stable id.** A question has no identity, so an answer cannot refer to it, and a rewrite of the memo erases it.
- **No history.** The overwrite destroys prior questions; a retrospective cannot count the ones that ended unanswered.
- **Answers are inferred.** Without a record, "the owner merged the PR, so they endorsed the concern" becomes a reading rule rather than a fact.

The cost is observed, not predicted: on 2026-10-13 the Orchestrator carried five open gates in one memo (a proposal awaiting approval, a schema batch, three decisions on one design, a migration's DDL, a wire change) and re-read them on every turn.

## 2. Model

A **DecisionRequest** belongs to one session:

| Field | Meaning |
|---|---|
| `id` | stable identifier (UUID), survives any rewrite of the memo |
| `sessionId` | the asking session |
| `workerId` | the asking worker; the target of the answer notification |
| `askedAt` | ISO-8601 time the request was recorded |
| `context` | what is being asked and why (markdown) |
| `recommendation` | what the asker recommends (markdown) |
| `status` | `open` / `answered` / `superseded` / `expired` |
| `answeredAt?`, `answerText?` | set when answered |

**`implicit-endorsed` is dropped from the Issue's status list.** It is exactly the inference the queue exists to make unnecessary: an answer is explicit, or the request is open. A status that records "the owner did not say anything but acted" would reintroduce the reading rule inside the data model, and every aggregation over it would silently count a non-answer as an answer.

Transitions:

- `open` -> `answered`: the owner answers (section 4).
- `open` -> `superseded`: the asker records a newer request that replaces it (the `supersedes` argument of `request_owner_decision`, section 4); done in the same transaction as the new row.
- `open` -> `expired`: manual (the owner dismisses a request), or automatic when the session is deleted (the asker is gone; nothing can hear an answer). Time-based expiry is not part of v1.

**Boundary values, stated.**

- *Zero open requests*: the panel is hidden and the count is 0; `list_owner_decisions` returns an empty list, not an error.
- *One request answered twice*: the second answer is appended to `answerText` (separated by a rule line), `answeredAt` moves to the latest answer, the status stays `answered`, and each answer is delivered. An answer never reopens a request.
- *A request for a deleted session*: **orphan, not cascade.** The row is kept and its open requests are set to `expired` when the session is deleted (one `UPDATE` in the deletion transaction, which `SessionDeletionService` already opens since the executor plumbing landed). Cascade would erase, every time a worktree session is cleaned up, the history that retrospective aggregation of unanswered questions is the reason for.
- *Answering a request whose asking worker is gone*: the answer is stored and the delivery reports a failure; the request is `answered` either way (storage is the record, delivery is best effort).

## 3. Storage decision: database, recommended

The Issue offers a database table (like review) or a file (like memo). Both precedents exist here, and the evidence is in the repository.

**File-backed per-session artifacts.** The memo above. Review annotations follow the same shape (`docs/design/diff-review-annotations.md`, `write_review_annotations`). Properties: lives in the session data path (`docs/design/session-data-path.md`), whole-file semantics, no schema, no migration.

**Database-backed per-session lists.** Three exist:

- `bookmarks`: migration v33 (`database/connection.ts:2028-2066`), `routes/bookmarks.ts`, kept in sync on the client by `bookmark-created` / `bookmark-deleted` app messages that carry an id only (`schemas/app-server-message.ts:433-441`).
- `timers`: `database/connection.ts:985-993`, `session_id` and `worker_id` columns, index on `session_id`, **no foreign key** to `sessions`.
- Inbound-event notifications, served by `routes/notifications.ts`.

| Criterion | File-backed (memo-style) | Database-backed (recommended) |
|---|---|---|
| Stable ids that survive a rewrite | No: one overwritten file per session; ids would have to be parsed out of prose | Yes: a row per request |
| Retrospective aggregation of unanswered questions | Not possible without scanning and parsing every session's file; deleted sessions lose theirs | A `GROUP BY status` over one table; rows outlive the session (section 2) |
| Multi-user visibility and access | Per-session file under the session's data path, same access as the memo | Per-session rows, same access check as the memo route (`assertCanOperateSession`) |
| Cost | No migration | One additive table: migration, repository, route, MCP tools, panel |
| Blast radius of a bug | Confined to one session's file | A shared table; a bad migration or query touches every session |
| What it does better | **Zero migration** | |

**Recommendation: database-backed.** The two properties the Issue asks for, stable ids that survive an overwrite and retrospective aggregation of unanswered questions, are exactly what a file-backed memo cannot give and what the existing database lists already give. The file option is rejected for the one reason stated in its last row: it avoids the migration, and the migration is the cost the property list justifies. The migration is the owner's decision.

### The owner-gate block (single source; the implementation Issue quotes it)

```sql
-- migration vNN: next free schema version at implementation time
-- (LATEST_SCHEMA_VERSION is 48 at ac2d6c83; another pending migration may claim 49)
CREATE TABLE IF NOT EXISTS decision_requests (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,           -- no FK to sessions.id: rows outlive the session (orphan, section 2)
  worker_id      TEXT NOT NULL,           -- the asking worker; the answer notification's target
  asked_at       TEXT NOT NULL,
  context        TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  answered_at    TEXT,
  answer_text    TEXT,
  CONSTRAINT decision_requests_status_check
    CHECK (status IN ('open', 'answered', 'superseded', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_decision_requests_session_status
  ON decision_requests (session_id, status);
```

Notes on the block: the `CHECK` constraint follows the precedent of `mcp_server_permissions_decision_check` (`database/connection.ts:2869`); the table is additive (no existing table is touched), so it follows the `migrateToV33` shape; `session_id` carries no foreign key, as in `timers` and `bookmarks`, because of the orphan decision above.

## 4. Surfaces

**MCP, for the asking session** (a session-claiming tool: `request_owner_decision` and `list_owner_decisions` are added to `SESSION_CLAIMING_TOOLS`, `mcp/session-claiming-tools.ts:11`, and gate the caller's claimed `sessionId` through `checkCallerOwnsSession`, like `create_conditional_wakeup`; a terminal agent passes its own session and worker ids, an embedded agent defaults to its own, proven by its bearer token):

- `request_owner_decision({ context, recommendation, supersedes? })` -> `{ id }`. Appends a row with `status: 'open'`; when `supersedes` names an open request of the same session, that request becomes `superseded` in the same transaction. A second call never overwrites the first (the motivating defect of the memo).
- `list_owner_decisions({ status? })` -> the session's requests. This is also how an agent catches up when a notification could not be delivered.

**REST, for the owner's UI:**

- `GET /api/sessions/:id/decisions` -> the session's requests (server-composed; the client renders only what this returns, invariant N1 of `docs/design/notification-center.md`).
- `POST /api/sessions/:id/decisions/:decisionId/answer { answerText }`.
- `POST /api/sessions/:id/decisions/:decisionId/expire` (the manual `expired` transition).

**Who may answer.** In multi-user mode, the session's own user and nobody else: the same chain as the memo write route (`routes/sessions.ts:130-141`, `assertCanOperateSession`). The MCP tools are not the owner's path; an asking agent cannot answer its own request.

**UI.** A "Pending decisions (N)" block beside `MemoPanel`, one row per open request showing context, recommendation and an answer box. N is the count of `open` requests; zero hides the block.

**Delivery of the answer.** Answering stores the answer, then notifies the asking worker through `SessionManager.deliverWorkerNotification(sessionId, workerId, params)` (`services/session-manager.ts:959`), the same seam inbound events and timers use, so the agent hears the answer as a turn instead of polling. The notification needs a new kind: `PTY_NOTIFICATION_KINDS` (`packages/shared/src/types/system-events.ts:74`) gains an entry (for example `internal-decision-answered`), with its `PtyNotification` interface in `lib/pty-notification.ts`. Because that list is read at runtime by the embedded-agent schema's picklist, adding the kind **moves `SCHEMA_VERSION`** even though no schema file's text changes (the picklist-source rule in `.claude/rules/pre-pr-completeness.md` Q10). Delivery is best effort and returns a structured failure reason (`WorkerNotificationResult`); a failed delivery leaves the request `answered`, and the agent reads it on its next `list_owner_decisions`.

**Realtime.** A trigger-only `decisions-updated` app message `{ type, sessionId }` tells clients to refetch (N1). Do not copy `memo-updated`, which carries `content` (`schemas/app-server-message.ts:406`): that message predates N1. The protocol-dispatch fixture rule applies at implementation (a change to the app-message union needs a wire-consumption fixture change).

## 5. What changes for the Orchestrator skill

The memo keeps status; the queue takes questions. The Orchestrator skill text changes accordingly: instead of listing owner questions in `write_memo`, it records each with `request_owner_decision` and reads the owner's answer from the notification (or `list_owner_decisions`). That text change belongs to the implementation Issue, not to this design.

## 6. Non-goals

Answering from Slack or webhooks; SLA timers; time-based automatic expiry (`expired` is manual, plus the session-deletion lifecycle consequence); per-question threading.

## 7. Implementation

Filed Issue: [#2080](https://github.com/ms2sato/agent-console/issues/2080) (the owner-gate DDL block comes first in the Issue). Tests it must carry, each with polarity against today: an answer reaches the asking session as a notification; a second `request_owner_decision` does not overwrite the first; **a memo overwrite leaves the queue intact** (the Issue's own motivating case, and the polarity against today's behaviour); session deletion expires its open requests in the same transaction; the wire kind and the `decisions-updated` message pass the strict schema and the dispatch fixture.

## Implementation Issue

[#2080](https://github.com/ms2sato/agent-console/issues/2080): `feat: owner-decision queue (decision_requests table + MCP/REST + panel)`. It carries the owner-gate DDL block first, quoted from section 3.
