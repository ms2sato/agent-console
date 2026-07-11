# Working Notes: In-Process Agent Direction (verification + handoff)

**Temporary working notes**, not a design doc. Feeds the "Design Decisions" section to be added to `in-process-agent-system.md`. Safe to delete once that section is written. Kept in-repo so the work survives an ephemeral-container / cross-session boundary.

## Goal

Offer, as an OPTION beside the terminal (PTY) AgentWorker + MCP model, an agent that owns its LLM loop and emits structured events. OpenAI API format first, local LLMs as the prime target. See `in-process-agent-system.md` (PR #1001, branch `claude/mcp-custom-ui-design-er7kc7`).

## Candidates under comparison (axis 1)

- **(a) in-process loop** — loop inside the server process; tool handlers call the service layer directly.
- **(b) per-user subprocess loop** — loop spawned AS THE REQUESTING OS USER, structured events over stdout, app-operation tools via the existing MCP server. **Leading hypothesis** (aligns with the elevation architecture).
- **(c) drive an existing headless harness/SDK**.

## Verification verdicts (from codebase, cited)

1. **Elevation primitives** — `spawnAsUser` (`packages/server/src/services/privilege-elevation.ts:450-512`) is a durable, caller-lifecycle-owned counterpart to fire-and-forget `runAsUser`; `sudo -u ... -i sh -c` argv via `buildSpawnArgs`; all stdio piped; `shouldElevateForUser` (:178-189) bypasses in single/same-user. **(b) can spawn a durable per-user loop cleanly.** Consumer obligation: `stdin.end()` + drain stdout (elevation-helpers.md, Issue #886).
2. **Restart durability** — The worker *record + on-disk output history* survives restart, NOT the process: dead-server workers are killed (`killOrphanWorkers`, `session-initialization-service.ts:355+`) and re-spawned on reactivation (new `epoch`). **(b) reuses this pid/serverPid/orphan machinery as-is; (a)'s in-memory loop vanishes on restart (regression).** Both need an external transcript for conversation continuity (new requirement).
3. **MCP caller identity — SELF-ASSERTED, not verified.** `fromSessionId`/`sessionId`/`repositoryId` are free tool args copied from server-injected `AGENT_CONSOLE_*` env; handlers check existence only (`mcp-server.ts:476-490`); binding deferred to Issue #878 (`:954-956`). **This is (a)'s one genuine advantage; (b) reusing MCP reinherits the gap.**
4. **delegate_to_worktree** — ~10 MCP-only orchestration steps (parent-id XOR, callback-prompt build, agent-name resolution, branch suggestion+fallback, SSH_AUTH_SOCK derivation, deletion rollback); actual creation is one `createWorktreeWithSession` call. **Medium, bounded registry-extraction cost; benefits all candidates.**
5. **WS protocol** — Terminal mechanisms (absolute byte offsets, epochs, gzip segments, resize, history-range) are PTY-only, but `GitDiffWorker` is a working precedent for a structured non-PTY schema (`packages/shared/src/types/git-diff.ts:201-223`) plugging into the same worker WS via a `worker.type` branch (`routes.ts:723-745`). **Confirms the "new per-worker-type schema" cost; not a blocker.**
6. **AgentActivityState** — Derived entirely by parsing PTY bytes (`ActivityDetector`); `activated` literally means `pty !== null`. A PTY-less loop would EMIT authoritative state instead of inferring it; `activated`/activity semantics must be redefined.
7. **Type/persistence blast radius** — New `Worker` union member + valibot schema (CLAUDE.md Q10) + persisted variant + DB migration/mappers + MCP response mappers. `PersistedGitDiffWorker` proves pid-less persistence is legitimate (helps (a)); (b) reuses the pid path (smaller persistence delta).

**Net:** (b) wins the hardest infra axes (restart durability, elevation reuse). (a) wins only on identity integrity (#3) and is non-durable across restart by construction. **Direction-changers:** solving Issue #878 tips it decisively to (b); declaring restart-resume out-of-scope removes (a)'s main liability.

## Fable 5 review — must-fix before advancing to a design PR

1. **"in-process" vs "own the loop" conflation** — most claimed benefits come from owning the loop, not from being in-process. Requires an Alternatives-Considered comparison ((a)/(b)/(c)).
2. **Multi-user identity/privilege elevation is absent** (biggest gap for this repo). (a) runs as the server user -> must thread `requestUsername`, regression risk vs the elevation investment. (b) spawn-as-user aligns natively.
3. **"MCP handlers are a thin adapter" is false** — see verdict 4. Re-scope registry extraction accordingly.

**Doc-accuracy fixes (apply regardless of winner):** WS "reused unchanged" is optimistic (verdict 5); the Agent concept also changes (agentId -> commandTemplate vs provider/model/key); local-LLM "fewest constraints" overstated; fix the non-PTY citation to `packages/shared/src/types/worker.ts` (the `session-worker-design.md` table is stale — still lists `DiffWorker` as future-only).

## ADR decision

No formal ADR mechanism exists in this repo; decisions are recorded as "Design Decisions" / "Alternatives Considered" tables inside design docs (precedent: `self-worktree-delegation.md` Decision 1/2 "why MCP"). Per pre-pr-completeness Q1, do NOT introduce a new ADR file type — reuse the in-doc table format.

## Decisions (owner)

- **Issue #878 (verified caller identity): IN SCOPE.** This tips axis 1 decisively to **candidate (b) per-user subprocess loop** — (b) can reuse MCP for app-operation tools while #878 closes the self-asserted-identity gap that was (a)'s only edge.
- **Restart-resume (conversation survives server restart): recommendation = DEFER to post-v1 (fast-follow), PENDING owner confirmation.** Rationale: under (b), a restart already kills + re-spawns the process exactly like today's PTY workers, so "no resume in v1" is parity, not a regression (resume is mandatory only under (a)). v1 ships the own-loop + structured-UI UX minimally; transcript persistence (with the hard mid-turn/mid-tool-call restore case) becomes an explicit fast-follow. Cost of deferring: worker-type behavior inconsistency (terminal continues via `-c`, new type resets) — must be stated in v1 doc/UI. Alternative if owner prefers UX consistency: include transcript persistence in v1.

## Next steps (ordered)

1. Confirm the restart-resume decision above (defer vs include), then write the **Design Decisions** section ((a)/(b)/(c) table) into `in-process-agent-system.md` using the verdicts above. Record (b) as the chosen candidate with #878-in-scope as the deciding factor.
3. Revise the note: present (b) alongside (a) (not "in-process" as a given); apply the doc-accuracy fixes; add a "Multi-user identity & privilege" section (cross-ref `.claude/rules/elevation-helpers.md`, `os-environment-coupling.md`).
4. `bun run check:lang` -> update PR #1001. Delete this notes file when the Design Decisions section lands.
