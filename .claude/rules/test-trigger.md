---
globs:
  - "packages/server/src/routes/**/*.ts"
  - "packages/server/src/services/**/*.ts"
  - "packages/server/src/mcp/**/*.ts"
  - "packages/client/src/hooks/**/*.ts"
  - "packages/client/src/components/**/*.tsx"
  - "packages/shared/src/**/*.ts"
  - "packages/embedded-agent/src/**/*.ts"
  - ".claude/hooks/**/*.sh"
  - "!**/*.test.ts"
  - "!**/*.test.tsx"
  - "!**/*.test.mjs"
  - "!**/__tests__/**"
---

# Test Coverage Requirement

When modifying production files matching these patterns, corresponding test files **must** be added or updated.

## Expected Test File Locations

| File Pattern | Expected Test Location |
|-------------|------------------------|
| `packages/server/src/routes/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/services/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/server/src/mcp/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/client/src/hooks/**/*.ts` | `.../__tests__/*.test.ts(x)` or sibling `*.test.ts(x)` |
| `packages/client/src/components/**/*.tsx` | `.../__tests__/*.test.tsx` or sibling `*.test.tsx` (a JSX-free pure-logic test may instead use `*.test.ts`, e.g. `SessionPage.test.ts` alongside `SessionPage.tsx`) |
| `packages/shared/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `packages/embedded-agent/src/**/*.ts` | `.../__tests__/*.test.ts` or sibling `*.test.ts` |
| `.claude/hooks/**/*.sh` | `.claude/hooks/__tests__/*.test.mjs` or sibling `*.test.mjs` |

## Exceptions

- **`packages/integration/src/`** uses a flat sibling layout (no `__tests__/` directory) for its boundary tests. This is deliberate: the package contains no production code — its entire `src/` is test infrastructure (`setup.ts`, `test-utils.ts`) and boundary tests (`*-boundary.test.ts(x)`). Do not move these files into a `__tests__/` subdirectory. The one exception is `src/e2e-native/`, which holds the two shipping-path e2e test files that require a separate `bun test` invocation without the happy-dom preload (see `src/e2e-native/setup-native.ts` for why, and `package.json`'s `test` / `test:coverage` / `test:watch` scripts for the two-invocation chain). This subdirectory is process-partitioning infrastructure, not a `__tests__/`-shaped test-to-production mapping, so it does not contradict the flat-layout rationale above.
- **`*.gen.ts` / `*.gen.tsx`** files are build-time generated (e.g. `packages/shared/src/schema-version.gen.ts` emitted by a codegen step). Their contents derive from an authoritative source at build time, so a hand-written sibling test would be tautological — test the generator, not its emitted output. The exclusion is anchored on the `.gen.<ext>$` suffix; files like `generator.ts` (substring "gen", no `.gen.` suffix) still require coverage.
- **Bare `types.ts` / `types.tsx` as a full path segment** are module-level type-definitions files colocated with their consumers (a natural React / Node.js convention — e.g. `packages/embedded-agent/src/tools/types.ts`). Same rationale as the `-types.ts` convention above: the type system enforces shape at consume sites. Exclusion is anchored on the segment boundary, so files like `mytypes.ts` (mid-segment match) or `type.ts` (singular, may contain runtime enums / factories) still require coverage.
- **Comment-only diffs** are exempted content-based, not path-based (Issue #1189). For each production file matching a coverage pattern, `preflight-check.js` inspects the file's actual diff hunks against the base branch (`git diff --unified=0`); if every added/removed line is a comment (`//`, `/* */` block, or `#` for `.sh`) or blank, the sibling-test requirement is skipped for that file. A mixed diff (any real code line alongside comment changes) still requires a sibling test. This exception cannot be expressed as a glob and is intentionally excluded from `check-mirror-drift.js`'s comparison, same as the `isTestFile()` negation entries above.

## Additional Verification: Preview Sandbox Real-Browser Check

PRs touching `packages/client/src/lib/preview-sandbox.ts`, `packages/client/src/lib/__fixtures__/preview-sandbox-corpus.ts`, or `packages/client/src/components/workers/PreviewPanel.tsx` must run `bun run check:preview-sandbox-browser` locally before pushing. This runs `scripts/run-preview-sandbox-browser-check.mjs`, which re-verifies the mXSS regression corpus against a real Chromium browser — `bun:test`'s happy-dom environment does not reproduce Chromium's HTML5 parsing edge cases (see `.claude/rules/os-environment-coupling.md`). This check is a real-browser regression gate, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: PTY Master FD Leak Check

PRs touching `packages/server/src/lib/pty-provider.ts` or `packages/server/src/services/worker-manager.ts`'s `detachPty` must run `bun run check:pty-fd-leak` locally before pushing. This runs `scripts/smoke/check-pty-fd-leak.ts`, which drives 100 real spawn/kill cycles through the production `bunTerminalProvider` and asserts that the process's ptmx-fd count (`/proc/self/fd`) and the kernel-wide allocated-pty counter (`/proc/sys/kernel/pty/nr`) stay flat — confirming `BunTerminalPtyAdapter.dispose()` actually releases the `Bun.Terminal` master-fd handle deterministically, rather than relying on the object becoming unreachable and incidentally GC-finalized (unsound in production, where `InternalPtyWorker.pty` stays reachable via session/worker maps for the life of the worker) (see Issue #1196). This check is a real-fd regression gate, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: Artifact Sandbox Boundary Real-Browser Check

PRs touching `packages/server/src/routes/artifacts.ts` (the `ARTIFACT_SERVING_CSP` header), `packages/server/src/routes/artifacts-viewer.ts` (the navigation-jail shell), or the `create_html_artifact` MCP tool in `packages/server/src/mcp/mcp-server.ts` must run `bun run check:artifact-sandbox-boundary` locally before pushing. This runs `scripts/smoke/check-artifact-sandbox-boundary.mjs`, which is the load-bearing real-Chromium probe for `docs/design/html-artifacts.md` §3's CSP sandbox boundary (premises P1/P2): it boots a disposable multi-user-mode server instance, creates a real artifact via a real MCP call, and drives a real headless browser through the opaque-origin document to confirm cookies, localStorage, credentialed same-origin fetch, external fetch, and external form POST are all blocked exactly as the design doc requires — plus same-run positive controls proving the walls are the sandbox's rather than the environment's. This check is a real-browser regression gate for a security boundary, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

Those same PRs must also run `bun run check:artifact-server-story-e2e`. This runs `scripts/smoke/check-artifact-server-story-e2e.mjs`, the real-HTTP server-story E2E for `docs/design/html-artifacts.md` §8's per-surface E2E (terminal half) and the create→serve→list→delete→serve round trip: it boots its own disposable multi-user-mode server instance, creates an artifact via a real `/mcp` JSON-RPC call (the actual terminal-agent-shaped call), verifies the artifact's stored `user_id` against the session's `createdBy` via a direct read of the disposable instance's SQLite file (the wire responses never expose `userId`), then drives the full `GET /:id` (exact CSP header) → `GET /` (list) → `DELETE /:id` → `GET /:id` (404) sequence as real HTTP. This check is a real-HTTP regression gate for the routes' shipping-path caller, not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

## Additional Verification: Fatal Incarnation Replacement Real-Tree E2E

PRs touching `handleEngineFatal` / `collectFatalIncarnation` / `fatalLeavesHarnessAlive` / the `fatalChainReplacementSpent` set in `packages/server/src/services/embedded-agent-worker-service.ts`, or that file's `deactivate` escalation, must run `bun run check:fatal-incarnation-replacement` locally before pushing. This runs `scripts/smoke/check-fatal-incarnation-replacement.ts`, the real-process E2E for the defect where a `claude-sdk` worker's `claude` grandchild dies while its harness stays alive: it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives a real `claude-sdk` incarnation through a real `sh` -> `bun` -> `claude` tree, and SIGKILLs **only the grandchild** -- the one death shape that produces no OS exit for the server to observe. It then asserts the incarnation is replaced, the stranded processes are gone, the dead incarnation's MCP token no longer verifies **against the token registry itself** (no frame can substitute for that), and that the conversation survived the process boundary by recalling a word planted before the kill. A mid-turn kill covers the `turn-interrupted` marker, and a whole-tree kill in the same run is the positive control proving the healthy path was not what changed.

This is a real-process regression gate for a defect the unit layer structurally cannot catch -- the wedge only exists because a live harness hides a dead engine, and every fake spawn has an exit the observer sees. It is not a sibling-test requirement, so it is not part of the `preflight-check.js` coverage patterns above.

Two properties of the script that matter when re-running it:

- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user, like the SDK probes under `scripts/smoke/`. It is a manual gate, never a CI job.
- **It has a polarity mode.** `bun run check:fatal-incarnation-replacement -- --expect-brick`, run against a build whose fatal routing is removed, **asserts the bug reproduces** rather than merely tolerating a failure -- a run that silently recovers is reported as a polarity failure. Use it to confirm the apparatus still reaches the defect before trusting a green run, per `workflow.md`'s "A check's existence is not its detection power".

## Additional Verification: Idle Eviction Both-Polarities E2E

PRs touching `packages/server/src/services/embedded-agent-idle-eviction.ts`, the eviction machinery in `packages/server/src/services/embedded-agent-worker-service.ts` (`touchIdle` / `onIdleExpired` / `ensureDeliverable`, the `ready` / `evicting` / `evictable` runtime fields, or `handleExit`'s `reason` classification), or `EMBEDDED_AGENT_IDLE_EVICTION_MS` in `packages/server/src/lib/server-config.ts`, must run `bun run check:embedded-agent-idle-eviction` locally before pushing. This runs `scripts/smoke/check-embedded-agent-idle-eviction.ts`, the shipping-path E2E for idle eviction (Issue [#1412](https://github.com/ms2sato/agent-console/issues/1412)): it boots a disposable server instance with a real `AppContext` and a real `/mcp` on a real port, drives two real `claude-sdk` workers through real `sh` -> `bun` -> `claude` trees, and lets the real server-side timer evict one of them.

**It carries both polarities in one run, and the negative control is the point.** Subject A is activated first and control B later, so at the instant A's countdown elapses B is still inside its own — without that, "A was evicted" cannot be distinguished from "everything gets killed". The run asserts A's harness and its `claude` descendant are gone while B's are both alive, that A's persisted row is stamped `reason: 'evicted'` and reaches the global worker-exit callback as such, that B has no `exited` row at all, and that a message to the evicted A wakes it and **recalls a nonce planted before the eviction** on the same SDK session id. B, asked the identical question, must answer `UNKNOWN` — that control is what makes A's recall attributable to the resume rather than to a guessable prompt.

Two properties of the script that matter when re-running it:

- **It is billable and needs a real, authenticated `claude` CLI** for the invoking OS user — the `claude-sdk` builtin runs as the executing user and uses that user's own authentication, so there is no API key to configure. Roughly five real turns per run. It is a manual gate, never a CI job, which is why it has a `check:` alias but no workflow.
- **`--idle-ms N` sets the threshold** (default 45 s) so a run takes minutes rather than the production half-hour. That substitution is upstream of and outside the chain under test: it changes how long the script waits to arrive at the eviction, never what eviction does.

**Do not weaken the graceful-exit assertion without re-measuring its reach.** The script asserts the `exited` row's `code` is `0` — that eviction went through the shutdown protocol rather than a signal — and that assertion exists because a mutation measurement showed the rest of the script could not tell the two apart. Replacing the deactivation call with a direct `SIGKILL` of the harness, which is exactly the hazard-line violation Issue [#1414](https://github.com/ms2sato/agent-console/issues/1414) makes dangerous, **passed all twenty other assertions**: the child dies anyway when it loses its stdio pipes, the exit observer still fires, and the reason is still `evicted`. Only the settle latency (1 ms against 253 ms) and the exit code moved, and the exit code is the one that separates them deterministically. The script's own comments carry that measurement and the negative control's known limit.

## Before Creating a PR

Run the coverage check to verify all production files have corresponding tests:

```bash
# With a PR number (uses gh pr diff):
node .claude/skills/orchestrator/preflight-check.js <PR-number>

# Without a PR number (uses local git diff against origin/main):
node .claude/skills/orchestrator/preflight-check.js
```

If any gaps are detected (non-zero exit code), add the missing tests before proceeding.

## Mirror Maintenance

The patterns above are a **markdown mirror** of the executable single-writer `COVERAGE_PATTERNS` in `.claude/skills/orchestrator/check-utils.js` (the source of truth used by `preflight-check.js`). When updating one, update the other in the same PR.

Drift between the two is detected mechanically by `.claude/skills/orchestrator/check-mirror-drift.js` (CI workflow: `.github/workflows/check-mirror-drift.yml`). To verify locally:

```bash
node .claude/skills/orchestrator/check-mirror-drift.js
```

The check normalizes the regex `^DIR\/.+\.EXT$` shape to its glob `DIR/**/*.EXT` equivalent and compares against both the markdown table above and the YAML `globs:` frontmatter. Negation entries in the YAML (`!**/*.test.ts`, `!**/__tests__/**`) mirror the `isTestFile()` helper rather than `COVERAGE_PATTERNS`, and are excluded from the comparison. (Issue #752)
