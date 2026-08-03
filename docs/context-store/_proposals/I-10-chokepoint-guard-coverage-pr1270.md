---
proposed_id: I-10
slug: chokepoint-guard-coverage
source_pr: 1270
source_issue: 1269
brewed_at: 2026-08-03
brewed_by: claude-fable-5 (orchestrator session 55213f05)
status: proposed
---

# I-10. Chokepoint Guard Coverage

## Why this PR warrants a new invariant

Issue #1269 found that `AGENT_CONSOLE_MCP_AUTH=enforce` gated only 5 of 22 MCP tools: the only auth mechanism was `checkCallerOwnsSession`, called inside individual tool bodies, so the 17 tools that never call it — including mutating ones — were reachable with zero credentials on a `0.0.0.0` bind. The Architect's ruling named the essential point: **the 17 ungated tools are not an accumulation of missed checks; they are the necessary consequence of the guard being per-call-site.** PR #1270 fixed it structurally with one transport-level middleware (`createMcpAuthMiddleware` mounted in front of the sole `mcpApp.all('/mcp', ...)` dispatch handler in `packages/server/src/mcp/mcp-server.ts`), so every present and future tool inherits protection by registration alone.

## Rule (draft)

When an obligation must hold for **every member of a family of entry points** (authentication for every RPC tool, audit logging for every mutating route, rate limiting for every public endpoint), mount the guard at the **single dispatch chokepoint** that all members already pass through — never inside individual members. If no such chokepoint exists, create one. Per-member checks are reserved for obligations whose predicate genuinely depends on member-specific data (e.g. "does the caller own the session this tool claims?") and compose **after** the chokepoint guard, not instead of it.

## Why it matters

A per-call-site guard covers exactly the call sites that invoke it. Every current member that does not — and every **future** member added by an author who has never heard of the guard — is silently unguarded: no error, no failing test, no type mismatch, no log line. Coverage degrades from a structural property into a per-author memory obligation, and the gap is invisible until someone probes an unlisted member from outside. The failure mode in one sentence: **a guard implemented as a convention silently excludes every member that does not follow the convention, and new members are born excluded.**

## Detection heuristics (draft)

1. **Count registrations vs guard invocations.** `grep -c 'mcpServer.tool('` vs `grep -c 'checkCallerOwnsSession('` (or the analogous pair). Inequality between "members of the family" and "guard call sites" is the smell — either the guard is a chokepoint (count 1, mounted before dispatch) or the counts must match exactly with a test enforcing it.
2. **Ask: "where is the one place every request in this family passes?"** If the answer is "inside each handler", coverage is convention. For Hono/HTTP surfaces the chokepoint is middleware in front of the dispatch route; for JSON-RPC-style multiplexed surfaces it is in front of the transport `handleRequest`, because tools are methods inside one route, not separate routes.
3. **New-member test.** Would a freshly-registered member be protected with zero additional wiring? If protecting it requires the author to remember to call something, propose the chokepoint instead.
4. **Bypass-parameter absence.** The chokepoint predicate should not accept inputs that could key a future exception (PR #1270's `evaluateMcpAuthGate` takes only resolved caller identity + mode — no request/header/source-address parameter, so a "but it's only localhost" bypass cannot be added without an explicit signature change).

## Resolution patterns (draft)

- **Transport-level middleware in front of the single dispatch handler** — the family-wide question ("is this caller anyone at all?") answered once, before any member body runs.
- **Layer composition, not substitution.** Member-specific predicates (ownership, scoping) stay in the members that need them and run after the chokepoint; the two answer different questions.
- **Where a true chokepoint cannot exist**, make the enumeration structural: a `satisfies Record<Member, Guard>` table or a test that mechanically diffs the registration list against the guard-site list (cf. the agent-operations exposure tables pattern, `pre-pr-completeness.md` Q11.5).
- **Containment polarity test.** Add a test that fails if someone re-introduces the per-member shape or an unguarded member (PR #1270's spoofed `X-Forwarded-For: 127.0.0.1` rejection test is this: it locks the absence of a bypass, not just the presence of the guard).

## Example (from source PR)

Before: `enforce` mode's rejection lived only inside `checkCallerOwnsSession`, reachable only from the 5 tools that claim a session. Probing any of the other 17 tools (e.g. `list_sessions`, `close_session`) with zero credentials returned real data / reached business logic under every auth mode. After: one `mcpApp.use('/mcp', createMcpAuthMiddleware(...))` in front of the sole dispatch handler; the same probes return HTTP 401 under `enforce`, and a newly-registered tool is covered with zero wiring. Had I-10 been in the catalog, the review question "where is the one place every MCP request passes, and is the auth guard mounted there?" would have surfaced the gap at the PR that introduced `checkCallerOwnsSession` — before 17 tools shipped ungated.

## Suggested acceptance criterion template

- [ ] For any guard introduced or modified in this change that expresses a family-wide obligation (auth, audit, rate limit, normalization over a set of routes/tools/handlers): the guard is mounted at the dispatch chokepoint all members pass through, OR the PR documents why member-specific data makes a chokepoint impossible and adds a mechanical enumeration test (registrations vs guard sites) → polarity test proving an unlisted/new member is covered (or the enumeration test fails when one is added unguarded)

## Review questions for owner

- Is this truly cross-cutting, or specific to the current PR? (Claim: the same shape governs REST route middleware vs per-route checks, hook execution guards, and any future tool surface — but MCP is the only incident to date.)
- Does it overlap with `design-principles.md`'s "Enforce constraints through structure, not convention"? That meta-rule states the spirit (and is aimed at the type system); this entry contributes the runtime-placement discipline and mechanical detection heuristics the meta-rule lacks. If the owner judges the meta-rule sufficient, reject as `duplicates-meta-rule`.
- Does it overlap with I-6 (Boundary Validation)? I-6 validates **values** crossing a boundary; I-10 places **caller-gating** so every entry point is behind it. Adjacent but different axes.
- Does it overlap with I-7 (Enumeration Exhaustiveness)? I-7 enumerates value **shapes** and tests each; I-10's preferred resolution is to make the enumeration unnecessary (chokepoint), falling back to structural enumeration only when a chokepoint is impossible.
- Is the AC template strong enough to be applied mechanically at acceptance-check time?
