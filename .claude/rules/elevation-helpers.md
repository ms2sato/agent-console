# Elevation Helpers

`packages/server/src/services/privilege-elevation.ts` is the single source for OS-level privilege-elevation primitives in this codebase: `runAsUser`, `spawnAsUser`, and `rmRecursiveAsUser`. This rule defines what a helper in this family must (and must not) do, and when a new helper should be extracted instead of inlining the same elevated-shell construction across multiple consumers.

## Why this rule exists

Sprint 2026-06-25 surfaced a cluster of PRs (Issues / PRs #871, #878, #879, #882, #884, #887) that all added privilege-elevation in different parts of the server. The first wave inlined the same `sh`-level command construction (recursive removal with `shellEscape`-protected path + `cwd: '/'`) at the service layer in each PR. Owner feedback during PR #888 review was the operative principle: "it's not enough that it just works; whether the code belongs at this layer matters." The pattern parallels git ops, which already have a clean encapsulation layer (`lib/git.ts`); inlined elevation-shell construction at the service layer broke that parallel.

This rule captures the design decisions that came out of that coordination so future elevation work is self-serve: helpers stay strict, semantic layering lives at the caller, and we extract a helper as soon as two PRs converge on the same shell-construction pattern.

## The strict-thin-wrapper contract

Every primitive in `privilege-elevation.ts` is a **thin wrapper** over `runAsUser` / `spawnAsUser` (or, for `runAsUser` / `spawnAsUser` themselves, over `Bun.spawn` with the `sudo -i` argv shape). The contract:

1. **Composes a fixed command shape** — argv, cwd, escape policy — for one elevation operation. Does not parameterize the shell beyond what the operation requires.
2. **Does NOT add semantic layering**: no ENOENT swallowing, no retries, no error wrapping into domain types, no idempotency contracts beyond what the underlying POSIX / shell command already provides.
3. **Returns the underlying `RunAsUserResult` / `SpawnAsUserResult` unchanged.** Callers branch on `exitCode` / `timedOut` / `stderr` and decide what those signals mean in their layer (e.g. "ENOENT on `rm -rf` is fine because cleanup is idempotent at the handler level"; "ENOENT on a setup helper is fatal because the artifact must exist").
4. **Bypasses elevation when** `username` is null / undefined / matches the server process user, via `runAsUser`'s existing short-circuit (`shouldElevateForUser`). The wrapper does not re-check; it inherits the contract from the layer below.
5. **Pins outer cwd to a safe location** (`/` for fs ops where the target may not exist) when the operation's semantics demand it. Document why in the helper's JSDoc.

### Why strict matters

Idempotency, retry, ENOENT-tolerance, and error categorization are properties of the **caller's semantics**, not properties of "do X as user". Examples from #882 review:

- `rmRecursiveAsUser`'s POSIX `rm -rf --` is exit-0 on missing-path because that's the POSIX `rm` contract speaking — *not* because the helper added idempotency. The handler's existing ENOENT branch on the in-process `fs.rm` side handles its own layer's semantics.
- A setup-time `mkdir -p` helper that succeeds on existing-dir does so because `mkdir -p` says so — not because we wrapped semantics around it.

When a helper starts layering semantics, downstream callers fight it: "I want the helper's ENOENT-swallow except in this one branch where I need to detect the missing path"; "I want the helper's retry except in this rebuild-only branch". Strict helpers are composable; semantic helpers spawn variants.

## Test-correctness DI is orthogonal to strict semantics

The strict-thin-wrapper agreement **does not preclude** transparently composable dependency injection for test seams. The DI hook is a *test-correctness* concern, not a *semantic* one.

Specifically: when a consumer class already maintains its own `runAsUser` injection point (e.g. `WorktreeService.runAsUserImpl` in the constructor), the helper must accept an optional `runAsUserImpl` parameter so the consumer can thread its seam through:

```ts
export async function rmRecursiveAsUser(
  path: string,
  username: string | null | undefined,
  opts: { timeoutMs?: number; runAsUserImpl?: typeof runAsUser } = {},
): Promise<RunAsUserResult> {
  const impl = opts.runAsUserImpl ?? runAsUser;
  return impl({ username, command: `rm -rf -- ${shellEscape(path)}`, cwd: '/', timeoutMs: opts.timeoutMs });
}
```

Without this, a `WorktreeService` test that mocks `runAsUserImpl` to capture argv assertions would silently turn into a real-`sh -c` invocation against the host filesystem the moment the helper is introduced. The DI param is **pay-as-you-go**: consumers without an existing seam ignore it and use the module-level default; consumers with a seam pay one 1-line `runAsUserImpl: this._runAsUser` opt-in.

This rule was discovered late in PR #888 (helper extracted in commit 4 of 4 after owner feedback). It would have been free to start with on commit 1 if the principle had already been documented.

## When to extract a new helper

Extract a new helper in `privilege-elevation.ts` when **either**:

- **Two-PR convergence**: two in-flight or recently-merged PRs introduce the same elevation-shell construction (same argv shape modulo arguments, same cwd-pinning, same escape policy), OR
- **One-PR multi-callsite**: a single PR introduces the same construction at three or more callsites within the same service.

PR #888 hit both: worktree-service.ts inlined `rm -rf -- ${escaped}` at two sites (force-fallback removal + orphan recovery), and PRs #890 and #891 were about to inline the same construction in unrelated services (cleanup-repository job, partial-clone cleanup). One coordinated extraction lands the helper in the elevation-helpers module and lets the sibling PRs consume it on their next rebase.

Do **not** extract a helper for:

- A one-off construction unique to a single consumer (the construction lives at the consumer; if a second consumer appears later, that PR triggers the extraction).
- A construction that diverges across callers in non-trivial ways (different cwd-pinning policy, different escape strategy, different stdin handling). Extraction would force a parameterized helper that is no longer a "thin wrapper".

## How extractions land

1. **Add the helper** in `privilege-elevation.ts` alongside its siblings. Keep the API surface minimal (the operation's required arguments + `timeoutMs` + `runAsUserImpl` DI).
2. **Add sibling tests** in `privilege-elevation.test.ts` covering the strict contract: null-bypass routes through `runAsUser`, elevated argv has the expected shape (including shellEscape edge cases like single quotes), cwd is pinned to the documented value, `timeoutMs` is forwarded, and the underlying `RunAsUserResult` is returned unchanged. Do NOT assert any semantic behavior beyond what the helper's contract guarantees.
3. **Refactor the originating consumer** in the same PR. The replacement must be line-for-line semantic-preserving — existing `runAsUser`-shape assertions on the consumer's tests should match without modification (because the helper composes the same argv).
4. **Update `docs/glossary.md`** entry for `requestUsername` (or the relevant entry) to mention the new helper alongside its siblings.
5. **Coordinate with sibling PRs** via the orchestrator: PRs that consume the new helper rebase and adopt it (typically a `force-with-lease` after explicit per-PR approval per `workflow.md`).

## How this rule is expected to evolve

As the helper family grows (`chmodAsUser`, `lstatAsUser`, etc. are plausible future additions when fs operations on cross-user paths come up), the naming pattern (`<verb>AsUser`) and the strict-thin-wrapper contract self-extend. This rule's body should not need to change; the glossary entry's enumeration of helpers should be updated in the same PR that adds the new primitive.

If a consumer surfaces a recurring need for semantic layering (e.g. "every caller of `rmRecursiveAsUser` ends up writing the same `if (exitCode !== 0) throw new DomainError(...)` block"), that is a signal to add a **separate** domain-level helper at the caller's layer — NOT to break the strict contract of the elevation primitive. The domain-level helper composes the elevation primitive plus the caller's semantics.

## Cross-references

- **Source**: [`packages/server/src/services/privilege-elevation.ts`](../../packages/server/src/services/privilege-elevation.ts) — current helper definitions.
- **Glossary entry**: [`docs/glossary.md` § requestUsername](../../docs/glossary.md) — the elevation context concept itself.
- **Umbrella issue**: [#837](https://github.com/ms2sato/agent-console/issues/837) — privilege-elevation pattern across the server.
- **Canonical example PRs**:
  - [PR #888](https://github.com/ms2sato/agent-console/pull/888) (Issue #882) — `rmRecursiveAsUser` extracted; first helper landed after owner's layer-correction feedback.
  - [PR #843](https://github.com/ms2sato/agent-console/pull/843) (Issue #838) — `git worktree add` elevation via `runAsUser`.
  - [PR #881](https://github.com/ms2sato/agent-console/pull/881) (Issues #869 / #870) — `lib/git.ts` consolidation; `gitExec`-routed helpers accept `requestUser`.
  - [PR #877](https://github.com/ms2sato/agent-console/pull/877) (Issue #876) — `delegate_to_worktree` resolves `parentSession.createdBy → osUsername`, hoist pattern.
  - [PR #880](https://github.com/ms2sato/agent-console/pull/880) (Issue #879) — `run_process` elevated via `spawnAsUser`.
- **Related Issues** (multi-PR convergence drivers):
  - [#871](https://github.com/ms2sato/agent-console/issues/871) — unregister-repository error surfacing (separate identity audit).
  - [#878](https://github.com/ms2sato/agent-console/issues/878) — MCP auth-boundary (caller-claimed `sessionId` verification); explicit out-of-scope for elevation PRs, addressed horizontally.
  - [#884](https://github.com/ms2sato/agent-console/issues/884) — CLEANUP_REPOSITORY job (PR #890), one of the consumers of `rmRecursiveAsUser`.
  - [#887](https://github.com/ms2sato/agent-console/issues/887) — `cleanupPartialClone` (PR #891), the other consumer.
- **Sibling rules**:
  - [`os-environment-coupling.md`](./os-environment-coupling.md) — when code depends on OS-level mechanisms (PATH, sudoers, login-shell init), real-machine smoke tests are mandatory. Elevation helpers are OS-coupled by definition; their consumers MUST follow the smoke-test discipline when introducing new elevated paths.
  - [`design-principles.md`](./design-principles.md) — "Grep for sibling call sites before implementing root-cause fixes" generalises the two-PR convergence trigger here.
