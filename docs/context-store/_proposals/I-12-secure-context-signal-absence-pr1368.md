---
proposed_id: I-12
slug: secure-context-signal-absence
source_pr: 1368
source_issue: 1366
brewed_at: 2026-08-30
brewed_by: Claude Sonnet 5 (delegate session, PR #1449 / §7f brewing catch-up)
status: proposed
---

# I-12. Secure-Context Signal Absence

## Why this PR warrants a new invariant

PR #1368 fixed HTML artifacts being unviewable from any plain-HTTP, non-localhost origin — including the owner's actual LAN address, the way this app is reached day to day. `routes/artifacts.ts` gated raw-byte serving on the request header `Sec-Fetch-Dest: iframe`, redirecting to the viewer shell on absence. But browsers only attach `Sec-Fetch-*` (Fetch Metadata) headers on **potentially-trustworthy origins** (HTTPS, or localhost) — so on a plain-HTTP LAN origin the header never arrives, including from the shell's own genuine iframe load. The shell then nested inside itself indefinitely.

This is not an isolated incident. PR #1346 (2026-08-17, merged one PR before this Issue's logging window began, so not itself a row in this log) fixed three call sites using `crypto.randomUUID()` / `navigator.clipboard.writeText` without a secure-context guard — both APIs are `undefined` outside a secure context, so calls threw or silently failed. #1346's own PR body states: *"The codebase had already solved this exact problem twice — `lib/id.ts`'s `generateTaskId()` and `EmbeddedAgentWorkerView.tsx`'s inline clipboard guard — but neither remedy had propagated to these three sites."* That is four prior local fixes for two APIs before #1346 consolidated them into `generateClientId()` and `copyToClipboard()` — and #1368 is a **fifth** instance, in a different layer (server-side header presence, not client-side API availability) and a different signal (`Sec-Fetch-Dest`, not `isSecureContext`).

Verified independently before drafting (not inferred from the PR body alone): `grep -rn isSecureContext packages/client/src` shows the guard now lives in `lib/clipboard.ts` (post-#1346 consolidation) but nowhere else generalizes the underlying principle; `grep -rn "Sec-Fetch"` shows the server-side handling is entirely local to the three `routes/artifacts*.ts` / `lib/artifact-viewer-tokens.ts` files #1368 added. No design doc, rule, or catalog entry states the general principle across both layers.

## Rule (draft)

**A browser API or a browser-attached signal that is gated on "secure context" (HTTPS, or localhost) is *unavailable*, not *false*, outside that context — and unavailable must never be read as a negative answer.** Client code calling such an API, and server code trusting such a signal in a request, must treat its absence as **unknown** and branch explicitly, never assume the API/header exists or that its absence means "the condition is false."

This applies on both sides of the wire: a client-side call to a secure-context-gated Web API (`crypto.subtle`, `crypto.randomUUID`, `navigator.clipboard`, `navigator.serviceWorker`, etc.) can throw or return `undefined`; a server reading a browser-attached signal that is itself secure-context-gated (`Sec-Fetch-*` Fetch Metadata headers, and by the same mechanism any future signal MDN documents as secure-context-only) can find the header simply missing on a request that is otherwise completely legitimate.

## Why it matters

The failure mode is a silent capability gap masquerading as either a **crash** (an `undefined` API called directly — #1346's `crypto.randomUUID is not a function`) or a **logic inversion** (an absent signal read as "the answer is no" instead of "the signal did not arrive" — #1368's infinite self-nesting redirect loop, which in multi-user mode degraded further into a raw `401`). Both are silent in development and CI: `localhost` and HTTPS-fronted staging are secure contexts, so every automated test environment and every developer's default workflow never exercises the absent-signal branch. The bug is only visible in exactly the deployment shape this project explicitly supports — a plain-HTTP LAN address — which is discovered by an operator, not by CI.

It also recurs because each fix has so far been scoped to the API or header at hand, not to the underlying physics. #1346 consolidated two APIs into two per-API helpers; #1368 introduces a third, independent mechanism (a viewer-shell-minted token) as a *fallback* for one specific header. Nothing states the general principle that would let a reviewer ask the question before the next API triggers the same investigation from scratch.

## Detection heuristics (draft)

1. **Grep for known secure-context-gated client APIs**: `isSecureContext`, `crypto.subtle`, `crypto.randomUUID`, `navigator.clipboard`, `navigator.serviceWorker`, `navigator.geolocation` (permissions differ but share the secure-context requirement), `navigator.credentials`. For each call site not already routed through `lib/clipboard.ts` / `lib/id.ts`'s existing guards, ask: *what happens if this API is `undefined` here?*
2. **Grep for server-side reads of Fetch Metadata headers**: `Sec-Fetch-Dest`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Sec-Fetch-User`, `Sec-Purpose`. For each, ask: *does this deployment's expected origin set include a non-HTTPS, non-localhost address, and if so, what is the code's behavior on header absence?*
3. **Ask whether the branch on presence/absence is written as `if (header) { trust it }` (implicit false-on-absence) or as an explicit three-way `if (present) / else if (fallback-mechanism) / else (deny, don't assume)`.** The first shape is the bug; the second is #1368's fix shape.
4. **Check whether `happy-dom` (this repo's client test environment) implements the API under test.** #1346's own test-plan notes `happy-dom` does NOT implement `isSecureContext` correctly and DOES implement a working `crypto.randomUUID`/`clipboard` by default — meaning a test suite green under `happy-dom` proves nothing about the guard unless the non-secure-context branch is explicitly constructed via `Object.defineProperty`. The same caution applies to any future secure-context test.
5. **For a new deployment surface (a new route, a new client entry point) ask explicitly whether plain-HTTP/LAN reachability is in scope** — this project's actual production deployment shape (per `docs/multi-user-setup-guide.md` and the owner's own dogfood environment) is exactly the origin class every secure-context API silently degrades on.

## Resolution patterns (draft)

- **Client-side**: route every secure-context-gated API call through a single named helper per API family (already the shape #1346 established: `lib/id.ts`, `lib/clipboard.ts`) rather than calling the raw API inline. The helper is where the fallback and the guard live once, not per call site.
- **Server-side, header-gated**: when the header can legitimately be absent for a class of otherwise-valid requests, design a fallback mechanism scoped to the request's own provenance (#1368's single-use, TTL-bound, artifact-id-bound token minted by the same server that will later check it) rather than trusting a second equally browser-conditional signal (the PR's own "Non-goals" section explicitly rejects a `Referer`-based fallback for exactly this reason — it "swaps one environment-conditional browser signal for another, re-enacting this Issue's exact failure class").
- **Verification**: any fix in this class needs a real-browser check against a genuinely non-secure origin (a plain-HTTP LAN IP, not `localhost`) — `happy-dom` and `127.0.0.1`-only smoke scripts cannot reproduce the absent-signal branch structurally, per detection heuristic 4.

## Example (from source PR)

`packages/server/src/routes/artifacts.ts`'s original gate: `Sec-Fetch-Dest` present and equal to `iframe` → serve; otherwise → redirect to shell. On the owner's plain-HTTP LAN address, the header never arrives (browsers strip Fetch Metadata headers on non-trustworthy origins), so every request — including the shell's own genuine iframe load — took the redirect branch, nesting the shell inside itself indefinitely and terminating in a client-side abort or a bare `401`.

The fix: `Sec-Fetch-Dest`, when present, always wins (unchanged, still authoritative where it exists); when entirely absent, a second, independent mechanism (a single-use viewer-shell-minted token, bound to the artifact id and a 60s TTL) decides instead — never a guess based on origin, never a second browser-conditional header.

TDD polarity was run against unmodified `origin/main` on the real reproduction shape (a real Chromium browser navigating a real plain-HTTP LAN origin, confirmed via network-log inspection that zero requests to that origin carried `Sec-Fetch-Dest`) before the fix, and re-run after — 4 assertions failing pre-fix (nested shell, no script execution, no failed request observed, no 401 reached) to 37 passing post-fix.

## Suggested acceptance criterion template

- [ ] Every new or modified call site touching a secure-context-gated browser API (client) or a Fetch-Metadata / browser-attached request signal (server) has an explicit, tested branch for the signal's **absence** — distinct from a tested branch for its **negative value** — with the absence branch never treated as equivalent to "condition is false"
- [ ] The absence branch is exercised by a real-browser check against a genuinely non-secure origin (a plain-HTTP, non-localhost address), not only by `happy-dom` or a `localhost`-only smoke script

## Review questions for owner

- Is this genuinely one invariant, or two (client-side API-unavailability vs. server-side header-unavailability) that happen to share a root cause? I read them as one — same physics (secure-context gating), same failure shape (absence read as false) — but the resolution patterns differ enough by layer that a reviewer might reasonably split them.
- Does the existing `lib/id.ts` / `lib/clipboard.ts` consolidation from #1346 already constitute "captured at the right layer" for the client-side half, leaving only the server-side half (new with #1368) as the gap worth cataloguing? If so, this entry's scope may want narrowing to the general *principle* (secure-context absence ≠ false) with the per-API helpers cited as the client-side resolution pattern already in place, rather than asking for new client-side consolidation this proposal does not actually need.
- Is there a natural home for a repo-wide list of "known secure-context-gated signals" (heuristics 1-2 above) — a comment block near `lib/clipboard.ts`, or a new small `lib/secure-context.ts` — so future additions to that list don't require re-deriving it from two incident PRs?
