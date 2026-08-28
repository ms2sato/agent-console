# Session Bookmarks

## 1. Motivation and requirements

PR [#1384](https://github.com/ms2sato/agent-console/pull/1384) (Issue #1379) shipped v1: a human registers an arbitrary URL (plus an optional title) from a session, and the console renders it as an external link. v1's Non-goals list opened with "Agent registration over MCP" and named it explicitly as **the premise-4 re-derivation trigger** -- the safety argument in `SessionBookmarksPanel.tsx`'s header JSDoc rested on "a person opens a URL they pasted themselves," and that premise does not survive agent registration unchanged.

Issue [#1390](https://github.com/ms2sato/agent-console/issues/1390) is that trigger firing: an owner directive to let MCP callers (and, through them, the Embedded Agent) register and delete bookmarks the same way a person does through the sidebar form. This document re-derives the threat model for that surface, states the new premise the render contract must satisfy, and specifies the resulting data model, identity anchors, and rendering contract.

## 2. Terminology

- **Bookmark** -- see [`docs/glossary.md`](../glossary.md#bookmark), the canonical entry. This document is that entry's `origin`/threat-model detail; the glossary entry is the summary and the pointer.
- **Origin** -- who registered a bookmark: `'user'` (through the sidebar form) or `'agent'` (through an MCP tool call). Provenance only, not an authorization scope -- ownership is always `userId`, regardless of origin.
- **MCP caller identity** / **`checkCallerOwnsSession`** -- see [`docs/design/embedded-agent-worker.md`](embedded-agent-worker.md) § "MCP caller identity" and `packages/server/src/mcp/mcp-auth.ts`. Reused verbatim here; not redefined.

## 3. Threat model

### 3.1 Why this is not just plumbing

v1's safety rested on a single premise: **a person opens a URL they pasted themselves.** The registrant and the reader were the same trusted party, so a friendly title next to a URL carried no additional risk -- the person who wrote the title is the person who will click it, and they already know what they meant.

Agent registration separates the registrant from the reader. The attacker is not the agent -- it is **whoever can inject into the agent's context**: a file in the worktree, web content the agent read while doing its task, another participant in a shared session. The agent is a confused deputy, faithfully relaying a `create_bookmark` call it was manipulated into making. The attack shape is a trustworthy-looking title over a hostile URL, placed on a surface (the session sidebar) the user trusts as their own console, populated only by their own actions. The asset at risk is the user's credentials on whatever site the hostile URL impersonates -- an asset that lives entirely outside this system, so the team-trust model this codebase otherwise relies on ("everyone with console access is on the same team") does not already cover it. Trusting your teammates does not mean trusting every URL an LLM was tricked into writing down.

**The v1 render already completes the attack, given a malicious title.** `SessionBookmarksPanel.tsx` (pre-#1390) rendered `{bookmark.title ?? bookmark.url}` with `title={bookmark.title ?? bookmark.url}` (the `title` *attribute*, i.e. the tooltip). When a title is present, the URL appears in neither the visible text nor the tooltip -- there is no path in the v1 UI to see the destination host before clicking. A registrant (human or agent) who supplies `title: "GitHub Login"` next to `url: "https://github-login.attacker.example/"` produces a row that reads exactly like a legitimate bookmark.

### 3.2 Premise survival table

| # | v1 premise | Verdict under agent registration |
|---|---|---|
| P1 | Server-side scheme allowlist (`http:`/`https:` only) | **Survives unchanged**, downgraded from "the gate" to "necessary but not sufficient" -- an `https:` phishing URL passes the allowlist just as easily as a legitimate one. The scheme check was never a content check. |
| P2 | `<a target="_blank" rel="noopener noreferrer">` | **Survives unchanged.** Tab-nabbing (a page the new tab opens rewriting `window.opener`) is a property of the anchor's `rel` attributes, independent of who registered the bookmark. |
| P3 | Text-node rendering of the URL/title (no `dangerouslySetInnerHTML`, no markdown/HTML interpretation) | **Survives, downgraded.** A text node cannot inject markup or script -- but it faithfully renders whatever plain text the registrant supplied, and that plain text is itself the attack surface (a deceptive title). Two additions close the gap this section's downgrade opens: bidi isolation (a title containing directional-override characters could visually reorder text to disguise a URL fragment) and a length cap (an excessively long title is a griefing/rendering-disruption vector, not a spoofing one, but cheap to close alongside the render-safety changes touching the same line). |
| P4 | Human-only registration | **Replaced.** See §3.3. |

### 3.3 New P4

> **The material for the click decision -- the URL's true host -- is always visible at click time, and cannot be suppressed, replaced, or pushed out by registrant-supplied text. The host is derived from the parsed URL (`new URL(bookmark.url).host`), never from a registrant-supplied string. The registration's origin (human / agent) is displayed.**

This moves the anchor of trust from *who registered the bookmark* to *what the user can see when deciding whether to click it*. Two properties make this hold structurally rather than by convention:

1. **The host is computed, not stored or passed through.** No registrant -- human via the form, or agent via MCP -- ever supplies a "host" field. The client always re-derives it from `bookmark.url` at render time via the `URL` constructor. There is no code path where a registrant's string reaches the host line.
2. **`URL`'s host normalization closes the homograph path in the same move.** The WHATWG `URL` parser applies IDNA-based normalization (Punycode) to the host component. A visually-confusable Unicode domain (`а` Cyrillic vs `a` Latin, etc.) normalizes to its `xn--` ASCII form, which reads as obviously non-human at a glance rather than as a plausible brand name. This is a side effect of using `URL` for host derivation, not a separate defense -- recorded here as a named premise so a future refactor that bypasses `URL().host` (e.g. a regex-based host extractor, for "performance" or "simplicity") does not silently drop it.

**Why an approval step was deliberately not adopted.** The natural alternative -- gate agent-registered bookmarks behind a human approval action before they become clickable -- was considered and rejected. What a user would see on an approval screen is the same title + host pair the list row already shows. Approval adds a click (friction) without adding information; the user is asked to approve the same two facts they will see again on the row itself. Host display adds the material that was actually missing at decision time (§3.1); an approval step re-presents material that display already provides, at the cost of a mandatory interruption for every agent-registered bookmark, including benign ones. Friction without new information is not a safety improvement.

**Re-escalation trigger (named).** If bookmarks ever gain any of: auto-open (a bookmark navigates a tab without a click), a server-side preview fetch (fetching the target to render a snippet/favicon -- also independently rejected as an SSRF surface, see §9), or sharing outside the owner's own console (another user or an external party can see another person's bookmark list) -- this trade-off must be re-derived from scratch. Each of those changes the thing the user is deciding at click time, or removes the click entirely, and P4's guarantee is specifically about what is visible *at click time*.

### 3.4 The same-class enumeration: agent-supplied text rendered clickable in the operator console

The failure shape here -- an agent-controlled string rendered as something a human clicks inside their own trusted console -- is not unique to bookmarks. Enumerating known and plausible members of this class, so a future feature does not have to rediscover the shape from scratch:

- **Bookmark (`url`/`title`)** -- this document. Mitigated by computed host display (§3.3) plus the P1-P3 carryovers.
- **Memo (`packages/client/src/components/sessions/MemoPanel.tsx`)** -- currently plain text, not a member of this class: the memo body is never rendered as an anchor, markdown, or HTML, and there is no MCP tool that writes it on an agent's behalf as of this writing. If memo content ever gains link rendering (auto-linkification, markdown support) or an MCP write path, it becomes a member and needs its own re-derivation under its own Issue -- do not fold that work into this document retroactively; file a fresh Issue against `MemoPanel.tsx` at that time, cross-linking back here for the general shape.
- **Any future free-text field an MCP tool can write that the client subsequently renders as a link, embed, or other clickable/navigable element** inherits this class by construction. The test for membership is: *(a) can an MCP caller (or, transitively, a confused-deputy agent) write the field, and (b) does the client ever turn the field's content, or a value derived from it, into something a click follows or a browser executes?* Both "yes" makes it a member.

## 4. Data model

### 4.1 `origin` column

Migration v34 (current at the time of writing is v33, the bookmarks table's own creation): `ALTER TABLE bookmarks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`, following v33's own idempotent form (`.ifNotExists()`-equivalent guard via the existing `columnExists` helper pattern used since v18).

Existing rows -- all created by the pre-#1390 human-only form -- backfill to `'user'` via the column default, which is correct: every row that predates this migration was, definitionally, human-registered.

### 4.2 Shared types and schemas (Q10 three-part set)

- `types/bookmark.ts`: `origin: 'user' | 'agent'` added to both the wire `Bookmark` interface and the server-internal record.
- `schemas/bookmark.ts`: `origin: v.picklist(['user', 'agent'])` added to `BookmarkSchema` (wire parse). `CreateBookmarkRequestSchema.title` gains `v.maxLength(200)`, matching `MAX_TITLE_LENGTH` in `mcp-server.ts` (the HTML artifact title cap) -- one length policy, reused rather than re-derived. The wire-side `BookmarkSchema.title` (used for *reading* existing rows) is deliberately **not** capped, to tolerate any legacy row that predates the cap; the cap is a write-time constraint only.
- `schema-version.gen.ts` regenerated (`node scripts/generate-schema-version.mjs`) -- required whenever `packages/shared/src/schemas/*.ts` changes; only the full `bun run test` suite's `schema-version.gen.test.ts` detects a stale hash (`.claude/rules/workflow.md`).

## 5. Identity anchors: REST and MCP deliberately differ

REST and MCP resolve "which user does this request act as" from **different anchors**, and that is correct, not an inconsistency to unify:

- **REST (`routes/bookmarks.ts`)** anchors on the `authUser` the auth middleware attached from the request's session cookie. `sessionId` (when present as a query param on `GET`, or in the body on `POST`) is a **pure secondary filter/provenance field, never an authorization check** -- this was already true in v1 and is unchanged. The trust boundary for REST is "does this HTTP request carry a valid cookie for a logged-in user," and that boundary is fully established before the handler runs.
- **MCP (`create_bookmark` / `delete_bookmark` in `mcp-server.ts`)** has no cookie. Its trust boundary is the session ownership chain: resolve the calling `sessionId` to a `Session`, require `session.createdBy` (a hard error if the session is legacy/ownerless), and attribute the bookmark to `session.createdBy` -- **never** to `getMcpCallerIdentity().userId`. `getMcpCallerIdentity()` is consulted only as an input to `checkCallerOwnsSession`, which asks "may this caller act on the *claimed* session," not "who does this write belong to." This is the exact division `mcp-auth.ts`'s `McpCallerIdentity` JSDoc states for `create_html_artifact`/`delete_html_artifact`, and is followed here verbatim: **MCP caller identity authorizes; the session ownership chain attributes.**

Why not make MCP mirror REST's `authUser`-anchored, `sessionId`-as-filter shape? Because MCP tool calls have no cookie to anchor on -- there is no `authUser` equivalent available at the `/mcp` endpoint, which is deliberately mounted outside the `/api` auth chain (see `mcp-auth.ts`'s module doc). The session ownership chain is not a downgraded substitute for a cookie; it is MCP's actual trust boundary, exercised by every other session-claiming MCP tool (`send_session_message`, `delegate_to_worktree`, `remove_worktree`, `create_conditional_wakeup`, `run_process`, `create_html_artifact`, `delete_html_artifact`). Bookmarks joining that list with the same shape is consistency *with MCP's own established pattern* -- forcing it to imitate REST's cookie-anchored shape would be the actual inconsistency, since MCP has no cookie to imitate REST with.

Both anchors independently satisfy the same requirement -- "attribute this write/read to the correct owning user, and refuse it otherwise" -- through the trust boundary actually available to each transport. Do not "unify" them by, for example, threading `authUser` through to MCP (it does not exist there) or having REST resolve `createdBy` through a session lookup (it already has a stronger, more direct signal in the cookie).

## 6. Surfaces

### 6.1 REST (unchanged shape, new field)

`POST /api/bookmarks` continues to set `origin: 'user'` unconditionally -- there is no REST path to register an `'agent'`-origin bookmark, by construction (a human at a browser is the only REST caller). `GET /api/bookmarks` now returns `origin` in each row.

### 6.2 MCP: `create_bookmark` / `delete_bookmark`

Modeled directly on `create_html_artifact` / `delete_html_artifact` (`mcp-server.ts`, the "Sixth"/"Seventh session-claiming tool" pair) -- same session resolution, same `createdBy`-hard-error, same `checkCallerOwnsSession` placement, same identity-layering comment reproduced verbatim (not paraphrased) at each call site, because the layering itself is the load-bearing fact, not incidental phrasing.

**`create_bookmark { url, title?, sessionId }`:**

1. The MCP tool's `zod` shape validates only *shape* (`url`/`title` are strings, `sessionId` is a string) -- it does **not** re-implement the scheme allowlist or the length cap.
2. The handler calls `v.safeParse(CreateBookmarkRequestSchema, { url, title, sessionId })`. `CreateBookmarkRequestSchema` (§4.2) is the **single writer** of scheme and length validation; a `zod`-side reimplementation is a named failure mode (§8) precisely because two independent implementations of "is this URL safe to store" drift, and the drift is invisible until a case only one of them rejects slips through.
3. On `safeParse` failure, return the schema's issue message via `errorResult`.
4. Resolve the session; missing session or missing `session.createdBy` is a hard error (mirrors the artifact tools exactly).
5. `checkCallerOwnsSession` per `mcpAuthMode`.
6. `bookmarkRepository.create({ userId: session.createdBy, sourceSessionId: sessionId, origin: 'agent', url, title, ... })`.

**`delete_bookmark { bookmarkId, sessionId }`:** resolve session + `checkCallerOwnsSession`, then compare `bookmark.userId === session.createdBy` (reject with an error otherwise -- non-owner cannot delete, mirroring REST's 403), then delete with the same not-found-is-idempotent handling as REST's `DELETE /:id` (a race between the existence check and the delete is not an error).

## 7. UI rendering contract

`SessionBookmarksPanel.tsx`'s row becomes three structurally distinct elements instead of one anchor:

1. **Title line** -- the existing anchor (`<a>`), still a text node, still `truncate`, with `unicode-bidi: isolate` added (closes the P3 downgrade's bidi gap, §3.2). When `title` is null, the anchor's text is the URL string (unchanged from v1).
2. **Host line** -- `new URL(bookmark.url).host`, rendered as an **independent text node outside the anchor**. This is the load-bearing structural choice: because it is a sibling element, not a child of the title's `truncate` container, no title length or CSS truncation can visually crowd it out. It is always rendered, including when `title` is null (title-null + host-line-present is not a special case -- the rule "host is always visible" is uniform regardless of whether a title exists).
3. **Origin badge** -- rendered only when `origin === 'agent'`. A human-registered bookmark shows no badge (matches the pre-#1390 visual baseline exactly, so this is additive, not a redesign of the human path).

The delete button is unchanged.

**Known limitation, deliberately deferred.** Agent-registered bookmarks have no WebSocket push -- the panel is a `useQuery` with a 60s `staleTime` (per `useSessionBookmarks.ts`), so a bookmark an agent just registered via MCP may not appear in an already-open panel for up to 60 seconds. Issue #1361's invalidation-hint pattern (a lightweight WS message that tells an open query "go refetch," without carrying the payload itself) is the anticipated eventual fix; it is not implemented here. This is a staleness/UX gap, not a safety gap -- P4's guarantee holds the moment the row does render, regardless of when that is.

## 8. Named failure modes (do not)

- Do not re-implement scheme or length validation outside `CreateBookmarkRequestSchema` -- neither in the MCP tool's `zod` shape nor anywhere else. One schema, one set of rules, reused by both transports that write a bookmark.
- Do not derive the host from a registrant-supplied string, under any name (`hostname`, `displayHost`, a "trusted" prefix, etc.). The host is `new URL(bookmark.url).host`, computed at render time, full stop.
- Do not put `userId` on the wire (unchanged from v1 -- `Bookmark`'s wire shape excludes it; `BookmarkRecord` is server-internal only).
- Do not "unify" the REST and MCP identity anchors (§5) -- each is correct against its own transport's actual trust boundary; making them structurally identical would either give REST a spurious session-ownership indirection it does not need, or give MCP a cookie it does not have.
- Do not synthesize or fetch titles server-side (unchanged from v1 -- no `<title>` resolution, to avoid an SSRF surface; see §9).
- Do not restate the two-condition list-scoping rationale (`sourceSessionId` as secondary filter, not authorization) in new JSDoc at each call site -- point at `bookmark-repository.ts`'s `findByUserIdAndSourceSessionId` doc comment, the canonical home.

## 9. Non-goals (v1.1 / this Issue)

- **Memo links.** Tracked separately per §3.4 -- the class enumeration belongs here, the fix (if MemoPanel ever needs one) belongs to its own future Issue.
- **A `list_bookmarks` MCP tool.** Not requested; an agent that just created a bookmark already has its id/url/title from the `create_bookmark` response.
- **Server-side title fetching.** Already rejected in v1 (SSRF surface) and re-rejected here; agent registration does not change the SSRF calculus, since the agent supplies its own title exactly as a human does.
- **An approval flow.** Rejected in §3.3, with its re-escalation trigger recorded there.

## 10. Verification floor

- Migration test (`database/__tests__/migration-v34.test.ts`, naming per the v18-v33 convention): column exists with the right shape, existing rows backfill to `'user'`, idempotent re-apply.
- `mcp/__tests__/create-bookmark.test.ts` / `delete-bookmark.test.ts`: ownership derives from `session.createdBy` (never caller identity), missing session, missing `createdBy`, mismatched-owner rejection (fail-closed), scheme rejection via the single-writer schema path (`javascript:alert(1)`), title length boundary (200 accepted / 201 rejected), title omission, `origin === 'agent'` on the created row.
- `routes/__tests__/bookmarks.test.ts`: POST yields `origin: 'user'`; GET returns `origin`.
- `sqlite-bookmark-repository` sibling test: `origin` round-trips through create/find.
- `SessionBookmarksPanel` test: host node renders as a sibling of the title node, not swallowed by `truncate`; a title containing a fake host string does not change the computed host node; the origin badge appears only for `origin: 'agent'`; a null title still shows a host line; a long title still leaves the host node present; an IDN URL's host renders in its Punycode form.
- `packages/integration/src` boundary test: REST create -> list -> `BookmarksListResponseSchema` parse, `origin` survives the wire (the Q10 wire-layer check).

All new/changed tests confirm polarity by the stash-diff method (`.claude/rules/testing.md`) against the pre-#1390 render and validation code.

## 11. Cross-references

- [`docs/glossary.md`](../glossary.md#bookmark) -- canonical terminology entry.
- [PR #1384](https://github.com/ms2sato/agent-console/pull/1384) / [Issue #1379](https://github.com/ms2sato/agent-console/issues/1379) -- v1 (human-only registration).
- [Issue #1390](https://github.com/ms2sato/agent-console/issues/1390) -- this re-derivation.
- [`docs/design/html-artifacts.md`](html-artifacts.md) § "Attribution" -- the session-ownership-chain attribution pattern this document's §5/§6.2 follows.
- [`packages/server/src/mcp/mcp-auth.ts`](../../packages/server/src/mcp/mcp-auth.ts) -- `McpCallerIdentity`, `checkCallerOwnsSession`, the "authorizes vs attributes" split.
- Issue #1361 -- the WebSocket invalidation-hint pattern referenced in §7's known limitation.
