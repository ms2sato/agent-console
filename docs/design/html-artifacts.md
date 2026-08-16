# HTML Artifacts

Status: **Draft — normative once merged.** Owner request 2026-08-16; design settled through Architect/Orchestrator consultation the same day (boundary ruling, four owner answers, one owner correction on surfaces). Implementation phasing is decided at AC time, not here.

## 1. Motivation and requirements

Users have AI agents produce HTML (reports, dashboards, interactive visualizations) and want to upload it to agent-console and view it in a browser. Requirements, as settled with the owner:

1. A tool that accepts HTML content and returns a **URL** for viewing.
2. Created artifacts are browsable as **per-user history**.
3. **Any logged-in user may view** any artifact (internal service; no unauthenticated URLs, no per-artifact ACL in v1).
4. **JavaScript in artifacts must execute** — the owner explicitly chose interactive artifacts over a safer static-only v1.
5. Size: inline content up to **5 MiB** per artifact.
6. Retention: artifacts persist **until manually deleted**. No expiry in v1 (deliberately deferred, not silently dropped).
7. The tool takes an optional **title**; when omitted the title is derived from the document, with a human-readable terminal fallback.

## 2. Terminology

- **Artifact**: a single user-uploaded HTML document stored by the server, addressed by a random id, owned by the user whose session created it, viewable by any authenticated user.
- **Artifact origin boundary**: the browser-level isolation that keeps artifact documents outside the app's cookie/localStorage/origin scope. See §3 — this is a specific mechanism, not a metaphor.

## 3. Security model — the boundary, named as the boundary

The existing chat preview (`PreviewPanel.tsx`) never leaves the browser: it renders a `blob:` URL in a token-less sandboxed iframe, so origin isolation comes for free. A server-hosted URL cannot use that trick — the artifact is served from the app's own origin, inside the app's cookie boundary, and (per requirement 4) it carries live script. The design therefore reconstructs the blob-URL property server-side.

Layering, in the same terms as `embedded-agent-worker.md`'s preview section: **the response headers are the boundary; the viewer page's sandboxed iframe is defense in depth; the sanitizer is not in this path at all.** Artifacts are served **byte-verbatim** (`X-Content-Type-Options: nosniff`, explicit `Content-Type: text/html; charset=utf-8`). Sanitizing at upload would mutate the user's bytes and would re-assign the sanitizer a boundary role the design documentation explicitly denies it. Corollary: the mXSS regression corpus and the tracked `KNOWN_GAP_VECTOR` (Issue #1162) do **not** transfer to this path — there is no sanitizer to bypass, and parser-mutation attacks change what renders, not which origin it renders in.

### 3.1 Boundary component 1: opaque origin via the CSP `sandbox` directive (response header)

The artifact-serving endpoint sends:

```
Content-Security-Policy: sandbox allow-scripts
```

The `sandbox` **directive in a response header** makes the browser give the document an **opaque origin** even though it is served from the app's origin: `document.cookie` and `localStorage` access throw, and the document is cross-site to the app for every request it initiates. This must be the header, not only an iframe attribute: any logged-in user can open the artifact URL **directly in a tab**, and only the response header protects that path. With scripts enabled, the direct-open path is no longer a theoretical bypass — it is a live-code escape route the attribute alone would leave open.

`allow-scripts` is present per requirement 4. Scripts run, but inside the opaque origin they reach no cookies, no localStorage, and no authenticated app API (see premise P2).

**MUST NEVER: `allow-same-origin`.** With scripts enabled, `sandbox allow-scripts allow-same-origin` on same-origin-served, user-authored HTML is a full XSS of the app origin. This combination is permanently forbidden, not a future knob.

### 3.2 Boundary component 2: resource CSP — v1 artifacts are self-contained

With live code, origin access is not the only escape: exfiltration and phishing-shaped form POSTs are. The same response therefore also restricts resources:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; form-action 'none'
```

Inline scripts and styles run; **no external network exists** — no CDN fetch, no exfiltration target, no form POST to anywhere. This matches the AI-generates-HTML flow (the generator inlines its dependencies), and an artifact that tries to load a CDN fails **loudly** (console error), not silently. `'unsafe-eval'` is deliberately excluded until a real artifact demands it. CDN allowance is a documented future knob whose trade-off (it opens an exfiltration channel) must be weighed when someone asks for it, not before. This `connect-src` fallback is also what currently makes P2 (§3.3) unreachable to probe through the artifact path: loosening `connect-src` (e.g. to allow CDN fetches) reopens the path to P2's wall, so a future PR loosening `connect-src` MUST carry the P2 probe (the direct cross-site credentialed-fetch probe described in §3.3's P2 entry) as a condition of that PR — the same pattern as P2a (a token addition requires re-deriving the boundary), extended to the `connect-src` directive specifically.

Accepted residuals, recorded so they are decisions rather than surprises: in-frame link navigation to external sites remains possible (that is browsing, not escape); an artifact can still *look* like anything, including a login form — it just cannot POST or fetch what it collects anywhere, which reduces visual deception to a social problem rather than a credential-exfiltration mechanism.

### 3.3 Named load-bearing premises

Per the project's premise-naming discipline: these are the claims this boundary cannot survive losing. Each is verified, and each gets a probe or test.

- **P1 — the CSP `sandbox` response-header directive produces an opaque origin in every browser the team uses.** If a browser ignored the directive, the boundary would silently degrade to nothing. Verified by the real-browser probe (§8), which asserts the walls hold **with scripts actually executing**.
- **P2 — the auth cookie is `SameSite=Lax`** (set in `routes/auth.ts`). Requests from an opaque origin are cross-site by definition, so Lax withholds the auth cookie even on `credentials: 'include'` fetches — this is what closes the CSRF route from artifact scripts into the app's API. **If anyone relaxes the cookie to `SameSite=None`, artifact scripts gain a CSRF vector.** This dependency is recorded here and must be recorded at the cookie-configuration site. P2 cannot be probed through the artifact path — layer 2 (the resource CSP's `connect-src` fallback to `default-src 'none'`) blocks all connect before P2's mechanism engages (discovered during Phase 1's V1, 2026-08-16). P2's receipt is therefore the source verification (`SameSite=Lax` in `routes/auth.ts`) plus a re-verification trigger: any future change adding `connect-src` to the artifact CSP MUST include a direct cross-site probe asserting a credentialed fetch arrives unauthenticated — the probe this arm could not be.
- **P2a (adjunct to P2) — the sandbox token set omits `allow-popups`, `allow-top-navigation`, and `allow-forms`, and that omission is load-bearing.** `SameSite=Lax` still sends cookies on top-level GET *navigations*; the missing `allow-popups`/`allow-top-navigation` tokens are what block an artifact from navigating the top-level context or opening windows to mount that route. P2 covers subresource fetches; the token omission covers navigation — two mechanisms, not one. The missing `allow-forms` token is a third: it blocks all `<form>` submission unconditionally, before CSP's `form-action 'none'` (§3.2) is ever consulted — `form-action` is a second wall behind it, currently unreachable in this configuration (verified empirically during V1; the probe observes the sandbox-layer block, not a CSP violation, since none fires). Anyone later adding `allow-popups`, `allow-top-navigation`, or `allow-forms` (e.g. for legitimate in-artifact interactivity) for a legitimate-sounding reason silently reopens the corresponding half — for `allow-forms` specifically, it makes `form-action 'none'` the live wall at that moment, which must then be re-verified rather than assumed already-proven; that addition requires re-deriving this boundary, not a one-line token append.
- **P3 — embedded agents reach MCP tools through an unfiltered `tools/list`** (see §6). If a per-caller tool filter is ever introduced, the artifact tool must be explicitly included for embedded callers, or the embedded surface silently loses the feature.
- **P4 — authentication on the serving route comes from the `/api` mount** (see §4); nothing outside `/api` has auth. Verified by a route-level test: an unauthenticated request to the serving route is rejected; an authenticated one succeeds. This premise exists because a draft of this spec asserted the property as inherited and was wrong for the route shape it proposed.
- **P5 — the viewer population is a trusted internal team.** This is the premise under requirement 3 ("any logged-in user may view any artifact") and the no-ACL / no-global-browse decisions that follow from it. Unlike P1–P4 it cannot have a probe — no test detects that the organization changed — so its honest form is a **re-derivation trigger**: if the authenticated population grows beyond the current team (new hires outside it, contractors, any request to share an artifact with someone who should NOT see all the others), requirement 3's no-ACL decision must be **re-derived, not extended**, BEFORE more URLs are distributed. Retrofitting per-artifact ACLs after URLs have circulated is materially harder than deciding at the trigger, so the cost of noticing late is asymmetric. The owner accepted no-ACL knowingly, on this premise; this entry is the record of what that acceptance rests on.

## 4. Serving, authentication, and URL shape

- **Authentication is NOT ambient — it comes from the `/api` mount, and only from there.** `authMiddleware` is applied in exactly one place (`routes/api.ts`'s `.use('*', authMiddleware)`, mounted at `/api` in `index.ts`); there is no app-level auth middleware, and top-level routes fall through to static serving / the SPA catch-all with **no auth at all** (`/webhooks` and `/mcp` are outside deliberately). Therefore the serving route MUST be registered **inside the `/api` mount** (e.g. `GET /api/artifacts/:id`), or — if a non-`/api` path is ever preferred for URL aesthetics — carry `authMiddleware` explicitly at the route, with the choice stated in the PR. A spec draft previously asserted this property as inherited ("sits inside the existing cookie-auth middleware"); that was token-level true and false for a top-level route shape — the mechanism is now named so an implementer has a reason to check it (premise P4, §3.3). Server-side, the handler reads the stored bytes and attaches the §3 headers.
- Artifact ids are **random UUIDs**. Unguessability is secondary once authentication gates viewing, but ids appear in logs and history, so they are random anyway and carry no user-derived structure.
- A **viewer page** in the SPA wraps the raw endpoint in `<iframe sandbox="allow-scripts" src="/artifacts/:id">` for the browsing UX (history list, title, delete button). The iframe attribute is defense in depth; the header on the framed response remains the boundary. Direct navigation to `/artifacts/:id` is safe by the same header.

### 4.1 `PUBLIC_ORIGIN` — the viewer-facing origin is a new configuration concern

No viewer-facing base URL exists in the codebase. `getMcpBaseUrl` is **not** it: its default is `http://localhost:<PORT>/mcp`, a same-host dial-back address for agent subprocesses — semantically wrong for a URL a human on another machine opens, in a way that passes every test run on a single machine and fails only when a second person clicks the link.

Design, with no mode-keyed inference anywhere:

- New config `AGENT_CONSOLE_PUBLIC_ORIGIN`: the origin the server believes it is reachable at by human viewers (e.g. `http://192.168.1.12:6340`). **No silent default.**
- **Unconfigured** (any mode): the tool returns the **relative viewer path** plus an explicit note that the origin is unconfigured. It never fabricates an absolute URL that is only correct on the server's own machine.
- **Configured**: the tool returns both the relative path and the absolute URL.
- Single-user dev convenience comes from dev tooling setting the value explicitly (`dev.sh` exports `http://localhost:<PORT>`); the multi-user setup script provisions it like `EMBEDDED_AGENT_BUN_PATH` (it knows the host it installs on).
- **Request-`Host` derivation is forbidden as a fallback**: MCP tool calls arrive over the localhost dial-back, so the `Host` header the tool handler sees is precisely the wrong value. This is stated here so no implementer reaches for it.

## 5. Storage, data model, attribution, lifecycle

### 5.1 Storage — a new top-level per-user namespace

Artifacts are user-scoped by requirement (per-user history), not session-scoped: tying them to the session-scoped layout would make history a cross-session scavenger hunt and would couple artifact lifetime to session lifetime, contradicting requirement 6. Therefore:

- Bytes: `<AGENT_CONSOLE_HOME>/artifacts/<users.id>/<artifactId>.html` — a new namespace, deliberately parallel to (not inside) `repositories/`.
- Metadata: a new `artifacts` table — `id` (UUID PK), `user_id` (FK `users.id`), `title`, `created_at`, `size_bytes`, `source_session_id` (nullable, provenance only — an artifact outlives its source session and the column is never used for lookup).

Lifecycle (pre-pr-completeness Q7, answered at design time): **created** by the tool (§6); **read** by the serving endpoint and the history list; **deleted** by the owning user (UI delete; optionally an MCP delete tool at AC time) — deletion removes the row and the file together; **never** auto-expired in v1. Files are written by the server process and owned by it — no elevation anywhere in this feature (multi-user viewers go through HTTP, never the filesystem). The deletion story ships in the same phase as the creation story.

### 5.2 Attribution — the session ownership chain, never the caller identity

The artifact's `user_id` is the **calling worker's session `createdBy`** — the same authN/authZ-vs-ownership layering as `delegate_to_worktree` (Issue #1293): MCP caller identity authorizes; the session ownership chain attributes. This works identically in single-user and multi-user, and identically for both surfaces in §6. A caller whose session has no resolvable `createdBy` gets a loud error, consistent with #1293's ownerless-parent handling.

### 5.3 Title resolution

`title` param → document `<title>` → first heading — and when the document has none of these, the terminal fallback is the literal **"Untitled"** (the history row already shows `created_at` beside it, keeping the list scannable). An artifact id is never used as a display title.

## 6. Surfaces — one MCP tool, two callers, no builtin variant

The owner's correction ("for the embedded agent it should be provided as a tool") is satisfied by existing machinery, and the tempting alternative is structurally excluded:

- **One MCP tool** (working name `create_html_artifact`; params `{ content, title? }`, content ≤ 5 MiB, server-enforced). Registered once in `mcp-server.ts`.
- **Terminal agents** reach it through their MCP client configuration, like every other MCP tool.
- **Embedded agents** reach it automatically: the embedded toolset is builtins merged with the server's `tools/list` (`packages/embedded-agent/src/main.ts` / `mcp.ts`), and no per-caller filter exists on that surface. To the model, the tool is indistinguishable from a builtin. (Premise P3.)
- **A `BUILTIN_TOOLS` variant is excluded by invariant, not preference**: `BuiltinToolContext` is `locationPath`-only — by its own documentation, a builtin tool cannot observe the MCP token or any server credential. An artifact tool must reach the server (storage, DB row, URL mint); from the subprocess that means the MCP channel. Widening the builtin context is a standing reject from the embedded-agent design series. Do not add a builtin variant later without confronting that invariant here.
- **No `AGENT_OPERATIONS` entry**: artifact creation is not an agent-directory operation, and force-fitting non-agent operations into that table is prohibited (the `send_session_message` precedent). Cross-surface parity for this feature is guaranteed by the per-surface E2E in §8, not by the exposure tables.
- **Path-taking params are out of v1 on both surfaces.** The blocker was never path confinement (the embedded side owns that primitive) but server-side reads of user-owned files under elevation. An embedded agent that wants to upload a file it has on disk composes builtin `Read` → inline `content`; a terminal agent does the same with its own file tools.

Tool result shape: `{ artifactId, path, url?, note? }` per §4.1 — `url` present only when `PUBLIC_ORIGIN` is configured; `note` explains its absence otherwise.

## 7. UI

- **History page**: the authenticated user's own artifacts, newest first — title, created-at, size, view link, delete. Others' artifacts are reachable by URL (requirement 3) but v1 has no global browse; that is a deliberate v1 cut, not an oversight.
- **Viewer page**: the sandboxed-iframe wrapper (§4), with title and owner shown outside the frame so artifact content cannot spoof the chrome around it — rendered **as a text node, never HTML-interpolated into markup or an attribute sink**, both in the viewer chrome and the history page's title column. The stored title is already stripped to plain text at write time (§5.3's title-resolution chain runs the fragment through a fixed-point tag-strip, closing the storage-time half of this obligation), but the render site must not rely on that alone: a future title write path (a rename API, an import) could bypass the strip, and this sentence is the boundary claim for the chrome specifically — it is either true or false at the render site, independent of what wrote the value. Required test: a `<script>`-bearing title injected directly at the storage layer (bypassing the strip, so the raw unstripped value is what's in the DB) must not execute when rendered in the history or viewer chrome.

## 8. Verification floor

- **The real-browser probe is load-bearing, not confirmatory** (P1/P2): a probe artifact whose script *executes* and attempts, in order — `document.cookie` read, `localStorage` access, a credentialed same-origin `fetch` to an authenticated app API, an external fetch (CSP-blocked), an external form POST (blocked by the sandbox token set's missing `allow-forms`, per P2a — `form-action 'none'` is a second wall behind it, currently unreachable in this configuration, so the probe observes and scores the sandbox-layer block rather than a CSP violation) — reporting each result via `postMessage`, the one channel the sandbox legitimately leaves open (an opaque iframe's DOM is unreadable from the parent, so `postMessage` is the harness protocol). The credentialed-fetch arm proves the CSP connect-block (layer 2), asserted via client-side rejection plus a server-side non-observation count (exactly one logged request across the probe window, attributable to the positive control rather than the sandboxed artifact); it does not and cannot probe P2 (`SameSite=Lax`) directly — see §3.3's P2 entry for why, and for the re-verification trigger that applies if `connect-src` is ever loosened. Runs under the real-browser runner (the #1162 precedent, pointed at the boundary instead of the sanitizer). This probe is the E2E floor of whichever phase ships the serving endpoint.
- **Per-surface E2E**: one real terminal-agent call and one real embedded-agent call of the tool, each asserting the artifact lands attributed to the correct user. Parity by test, not review — the embedded-agent-v1 lesson (#1042–#1044).
- **Unconfigured-origin behavior**: a test asserting the tool returns relative-path-plus-note when `PUBLIC_ORIGIN` is unset, and both forms when set.
- **Auth on the serving route (P4)**: unauthenticated request rejected, authenticated request succeeds — a real-route test, not an assumption about middleware inheritance.
- **Transport capacity check (AC-time, before implementation)**: verify a real ~5 MiB `content` param actually traverses the `/mcp` JSON-RPC transport — no `bodyLimit` was found on `/mcp` (the only one in the codebase is on `/webhooks`), but "no limit found" is not "verified to accept it", and a JSON-escaped 5 MiB HTML payload is meaningfully larger on the wire. If the transport rejects it, the cap or the mechanism changes at AC time, not after a real dashboard fails to upload.
- Standard suite/typecheck/preflight per `workflow.md`; storage and route code carry sibling tests per `test-trigger.md`.

## 9. Non-goals (v1)

Expiry and quota automation; CDN/external resources in artifacts (documented knob, trade-off stated in §3.2); path-taking tool params; per-artifact ACLs or sharing outside authenticated users; artifact editing/versioning (re-upload is a new artifact); a builtin-tool variant (§6, invariant); an `AGENT_OPERATIONS` entry (§6); server-side rendering or screenshotting.

## 10. Accepted risks (consolidated)

Each risk below was accepted as a deliberate decision; the reasoning lives next to the decision it belongs to, and this section exists so the approval question — "what am I accepting?" — has one answer instead of five. Pointers, not duplication:

| Accepted risk | Where decided |
|---|---|
| Any authenticated user can view any artifact; no per-artifact ACL, no global browse | §1 req. 3, §7 — resting on premise **P5** (§3.3): trusted internal team, with a stated re-derivation trigger |
| Artifact scripts run (`'unsafe-inline'`); an artifact can visually imitate anything, including a login form | §3.2 — cannot POST or fetch what it collects anywhere (`form-action 'none'`, no network); visual deception reduced to a social problem |
| In-frame navigation to external sites remains possible | §3.2 — browsing, not escape |
| No expiry, no count quota; artifacts accumulate until manually deleted | §1 req. 6, §9 — deliberate v1 cut |
| Boundary rests on named premises P1–P4 (opaque-origin support, `SameSite=Lax` cookie, unfiltered embedded tools-list, `/api`-mount auth) | §3.3 — each with its probe/test, and each with the consequence of losing it stated |
| Unconfigured `PUBLIC_ORIGIN` degrades the tool result to a relative path | §4.1 — loud and actionable over silently-wrong absolute URLs |

## 11. Open items deferred to AC time

Phase decomposition (likely server-first then UI, decided with the Orchestrator); exact route paths and table DDL; whether an MCP delete/list tool ships in v1 alongside the UI; the probe's harness wiring into the real-browser runner script.
