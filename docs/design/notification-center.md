# Notification Center

Status: **Draft — normative once merged.** Owner request 2026-08-17 ("bell + list" confirmed 2026-08-18); architecture settled through Architect/Orchestrator consultation (the record/awareness decomposition and the read-model ruling, 2026-08-17). The two items the design left to the owner — feed scope and the obligations lane — were both decided on 2026-08-18 and are recorded inline below (§6, §8). Phasing is decided here; per-phase ACs at dispatch time.

## 1. Motivation

Four independent incidents in one day shared a single shape: *something happened, and a human who wasn't watching at that moment had no way to find out* — an artifact was created (no surfacing at all), a worktree deletion completed (one-shot broadcast, [#1327](https://github.com/ms2sato/agent-console/issues/1327)), sessions were restored after a restart (nothing), and an inter-session message notification referenced a file that did not exist ([#1330](https://github.com/ms2sato/agent-console/issues/1330)). Fixing each individually produces four unrelated mechanisms. This design gives the shared half — awareness — one home.

## 2. The two-axis decomposition (the load-bearing cut)

Every "did the human find out?" gap decomposes into two independent questions:

- **(A) Record**: does the event have a durable, authoritative address (a domain row) one can consult later?
- **(B) Awareness**: is there a surface where a human discovers what happened while not watching?

**This document builds (B) only.** (A) gaps remain per-domain work (e.g. #1327 gave deletions a job record; restart-restoration still has no record and is [#1344](https://github.com/ms2sato/agent-console/issues/1344)'s concern). The dependency is one-directional: an event participates in (B) **only if** it already has (A). That admission rule is what keeps this design from becoming a second bookkeeping system.

## 3. Architecture: a composed read-model, not an event store

**v1 writes no notification rows.** `GET /api/notifications` composes a unified list from existing domain stores at request time (v1 sources: `artifacts`, terminal `worktree:delete` jobs). Each item is a **pointer + summary** derived from the domain row; the domain row remains the only truth.

- **Invariant N1 (the #1330 lesson, structural form): the list renders ONLY from domain rows read at fetch time. WebSocket broadcasts are cache-invalidation hints — a broadcast may trigger a refetch, but its payload is never itself rendered into the list.** A phantom broadcast therefore degrades to a refetch that finds nothing; an entry without a backing record is unrepresentable.
- **Invariant N2: notification items carry no state of their own** — no per-item status, no copies of domain fields beyond the render summary. Anything that must survive belongs on the domain row.
- The materialized-table alternative (an `app_events`/notifications table every producer writes) is documented as the **escape hatch, not the start**: it becomes worth its cost only if source composition grows past a handful of queries, and it imports the "producer forgot to write" failure mode this design avoids. Revisit trigger: >4 sources or measurable list-latency pain.

New persistent state, exactly one row per user: `user_notification_cursor (user_id PK, last_seen_at)` — see §5. This is not double bookkeeping; the cursor is a fact about the user that exists nowhere else.

## 4. Admission rule for event kinds (a rule, not a list)

An event kind may appear in the list iff ALL hold:

1. **(A) exists**: a durable domain record with a stable id, a timestamp, a human-renderable summary, and a deep link target.
2. **Relevance**: knowing it changes what the human does next (actionable), OR it is the terminal state of an operation a human initiated.
3. **Human-addressed**: agent-to-agent plumbing (inter-session messages, `[inbound:*]` PTY delivery) is excluded — those have their own delivery ledger and audience.
4. **Feed-shaped**: discrete occurrences, not streams. High-frequency signals (per-token output, per-poll usage) are excluded by construction.

Applying this today: **in** — artifact created; worktree deletion reached `completed`/`stalled`. **Out, with reasons recorded** — restart-restoration (fails rule 1; banner-class UX anyway, #1344), worktree creation / session-stop tasks (fail rule 1 until their #1327-sibling migrations land — they become candidates the day they get records), inter-session messages (rule 3), inbound webhook events (rule 3 — agent-directed; the agent's visible actions are the human-relevant outcome).

## 5. Read semantics

- **Per-user, server-persisted.** Multi-user is real; a shared read state would mark items read for people who never saw them. Server-side (not localStorage) so the state follows the user across browsers. Single-user mode has one user row and degenerates cleanly.
- **"Seen", never "handled."** Opening the bell advances `last_seen_at` to the newest listed item's timestamp (`PUT /api/notifications/seen`). The badge shows the count of items newer than the cursor. There is no per-item read state in v1 — the cursor is a high-water mark, which exactly matches bell-badge semantics and keeps storage at one row per user.
- Consequence, stated honestly: an individual item cannot stay "unread" once anything newer has been seen. That is acceptable for awareness; anything needing per-item acknowledgment is an obligation (§6) and does not belong in this lane.

## 6. Obligations are a different lane (deferred with an address)

An obligation ("this failed and needs a decision") clears by **doing**, not by **seeing**. Mixing obligations into a cursor-read list makes them vanish from attention on first glance — precisely the failure this feature exists to fix — and forcing per-item acknowledgment into the list to compensate would drag v1 into materialized-state complexity. Therefore: **v1 is awareness-only** (owner-confirmed, 2026-08-18). The bell UI is a shell that can later host a second, separately-sourced "action required" section (derived live from domain state: e.g. `stalled` jobs not yet retried), additively, without reworking the list. That lane, if wanted, is its own design — this section is its address.

## 7. Boundaries with existing mechanisms (taxonomy — nothing is replaced)

| Mechanism | Role | Relation |
|---|---|---|
| `NotificationManager` + Slack handler | outward push to an external surface | unchanged; may later consume the same domain events — no unification in v1 |
| `inbound_event_notifications` | delivery ledger, **agent**-addressed (PTY injection) | unchanged; different audience axis — deliberately NOT reused as the human store |
| PTY `[inbound:*]` / `[internal:message]` | agent-addressed delivery | unchanged (its own hardening track: #1330; its in-worker presentation: [#1351](https://github.com/ms2sato/agent-console/issues/1351)) |
| Owner memo | orchestrator workflow artifact | unchanged |
| **Notification center (this)** | **human**-addressed awareness read-model over domain records | new; layered on top, replaces nothing |

## 8. Wire shape and API

- `NotificationItem` (shared type + valibot schema, strictObject; `pre-pr-completeness.md` Q10 applies): `{ kind: 'artifact-created' | 'worktree-deletion-finished', id: string, occurredAt: string, title: string, link: string, outcome?: 'completed' | 'failed' }`. `id` is `kind`-scoped (the domain row's id); `(kind, id)` is the stable identity.
- `GET /api/notifications` → `{ items: NotificationItem[], lastSeenAt: string | null, unreadCount: number }` — newest first, capped (v1: 50, an accepted cut; no pagination). **Amendment (Phase 1 AC, #1353):** `unreadCount` is computed server-side **pre-cap** (before the 50-item cap is applied), so the badge stays accurate once unread exceeds the cap — `items` alone cannot express this since it is truncated.
- `PUT /api/notifications/seen { lastSeenAt }` — monotonic (server rejects moving the cursor backwards).
- **v1 scope: personal feed** (owner-confirmed, 2026-08-18) — items the user owns or initiated (artifacts by `user_id`; deletion jobs by payload `requestUsername`). A global team feed is a deliberate non-goal, revisitable later; personal-to-global is an easy widening, global-to-personal is not.
- Client: bell in the header; badge = server-computed unread count; opening the panel fetches the list and advances the cursor; app-WS events for the covered kinds act as invalidation hints only (N1; `artifact-created` has no broadcast source yet, so an artifact created while the tab is already open surfaces on the next refetch trigger rather than instantly -- tracked as a follow-up, see Phase 2 AC Ruling 1).

## 9. Phases

- **Phase 1 — server**: shared type/schema, the two v1 composers, cursor table + migration, `GET`/`PUT` routes, sibling + wire-boundary tests (Q10 integration test for the new wire shape).
- **Phase 2 — client**: bell + list panel + badge + seen-advance + WS invalidation hints; Browser QA with true-path screenshots (bell showing a real unread artifact/deletion, panel open, badge clearing).
- **Phase 3+ (each its own decision)**: additional sources as they earn records (§4 rule 1); obligations lane (§6); banner-class events (#1344); Slack-consumer unification; global feed.

## 10. Non-goals (v1)

Per-item read state; obligations/action-required (§6); global team feed (§8); replacing any §7 mechanism; a materialized event store (§3 escape hatch); push notifications (browser/OS); pagination; retention policies (the list mirrors domain-record lifetimes — deleting the artifact removes its notification, which is N1/N2 working as intended, recorded here so it reads as a decision).

## 11. Open items at AC time

Exact badge-count query shape; whether `worktree-deletion-finished` links to the task page or the repository view; empty-state copy; the Phase 2 bell placement relative to the existing header nav.
