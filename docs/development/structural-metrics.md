# Structural Metrics

Tooling for **structural** cohesion/coupling review — the part of code quality you can evaluate from the dependency graph alone, without domain knowledge.

- `dependency-cruiser` — forbidden-import rules (layer boundaries, deep imports, I/O localization, circular deps).
- `knip` — dead code (unused files, exports, dependencies).

`bun run lint` is the recommended single command — it runs the full structural lint suite. Individual entries remain for targeted runs.

```bash
bun run lint              # alias for lint:structure (recommended)
bun run lint:structure    # dep-cruiser + knip
```

Or individually:

| Command | Purpose |
|---------|---------|
| `bun run lint:deps` | dependency-cruiser against baseline (`--ignore-known`) |
| `bun run lint:deps:all` | dependency-cruiser, including known violations |
| `bun run lint:deps:baseline` | regenerate `.dependency-cruiser-known-violations.json` |
| `bun run lint:cycles` | same dependency-cruiser run as `lint:deps`, kept as a named entry point for anyone reaching for "just the cycle check" by habit |
| `bun run lint:unused` | knip dead-code / unused-deps |
| `bun run graph:deps` | render the dependency graph to `dependency-graph.svg` (requires Graphviz `dot`) |

> **Note.** ESLint is not currently installed in this project. When it is introduced, add a `lint:eslint` script and chain it from the `lint` umbrella (e.g., `"lint": "bun run lint:eslint && bun run lint:structure"`) so both style and structural checks run under the same command.

CI runs both on every PR — see `.github/workflows/structural-metrics.yml`.

> **History.** Circular-dependency detection used to run twice: dependency-cruiser's `no-circular` rule, and `madge` as a supposed "second opinion" via `lint:cycles`. It wasn't a second opinion in practice — madge's only way to silence a false-positive cycle (it cannot tell `import type` from a value import, edge by edge) was `.madgerc`'s `excludeRegExp`, which removes the whole file as a graph node. That blinded `lint:cycles` to any future real cycle through one of the ten excluded files, and one appeared: `session-manager.ts <-> session-pause-resume-service.ts` gained a genuine (if type-only) cycle that `lint:cycles` silently never reported (Issue #1487). dependency-cruiser's `viaOnly.dependencyTypesNot` restriction (see the `no-circular` row below) expresses the same "ignore type-only cycles" intent per-edge instead of per-file, so `madge` and `.madgerc` were removed rather than fixed.

## What each tool does

### dependency-cruiser

Enforces architectural rules encoded in `.dependency-cruiser.cjs`. Rules are named and commented; the config file is the spec.

Current rule set (small and deliberately meaningful):

| Rule | What it prevents |
|------|------------------|
| `no-circular` | Runtime circular dependencies. A cycle is a violation only when every edge in the ring is a value-level import (`viaOnly.dependencyTypesNot: ['type-only']`); a cycle with even one `import type` edge is erased by `tsc` before the code runs, so it isn't a runtime cycle. |
| `client-no-runtime-import-from-server` | Client bundles must not pull server source at runtime. Type-only import from `@agent-console/server/api-type` is the sanctioned RPC contract. |
| `server-no-import-from-client` | Server must not depend on client. Shared code belongs in `packages/shared`. |
| `no-deep-import-into-shared` | Consumers of `packages/shared` use the package entry (`index.ts`), not internal subpaths. |
| `no-fs-in-route-handlers` | `routes/`, `middleware/`, `websocket/` must not touch `fs`/`fs/promises` directly. The I/O surface lives in `lib/` or services. |
| `no-process-spawn-in-route-handlers` | Same shape for `child_process`. (`Bun.spawn` is a global — reviewers still need to watch it manually until we wrap it.) |
| `no-reverse-dep-service-to-delivery` | Services must not import from `routes/` or `websocket/`. Delivery depends on services, not the other way around. |
| `not-to-unresolvable` | Catches dangling imports. |
| `no-duplicate-dep-types` | Dependency listed twice (dev + regular). |

### knip

Finds unused files, dependencies, and exports. Rule severities in `knip.json` are tuned to focus on **meaningful** findings:

- `files`, `dependencies`, `devDependencies` → **error** (real signal)
- `exports`, `types`, `nsExports`, `nsTypes`, `classMembers`, `enumMembers` → **off** (too noisy in barrel-heavy codebases; dep-cruiser's orphan detection is better)
- `duplicates`, `unresolved`, `unlisted` → **warn**

## Rule-authoring philosophy

Favor a **small number of meaningful rules** over many cosmetic ones. Before adding a rule, ask:

> Would a violation of this rule actually indicate a design problem?

If the answer is "not really, it's just style," drop the rule. Cosmetic rules accumulate exceptions, become noise, and train reviewers to auto-dismiss tool output.

Every rule in `.dependency-cruiser.cjs` carries a `comment` field describing:
1. What violating it means structurally.
2. How to fix it (or when it is legitimately allowed).

## Adding a new rule

1. Open `.dependency-cruiser.cjs` and add a rule object to the `forbidden` array.
2. Required fields: `name` (kebab-case), `severity` (`error` | `warn` | `info`), `comment` (explain *why*), `from`, `to`.
3. Run `bun run lint:deps:all` to see baseline violations.
4. Classify each finding: fix, grandfather, or revise the rule (see below).
5. Update this document's rule table.

## Grandfathering legitimate exceptions

When the current codebase has violations you do not plan to fix in the same PR, choose the narrowest mechanism:

| Tool | Mechanism | File |
|------|-----------|------|
| dependency-cruiser | `depcruise --output-type baseline` → `--ignore-known` | `.dependency-cruiser-known-violations.json` |
| dependency-cruiser | Per-rule `from.pathNot: [...]` with a `GRANDFATHERED` comment | `.dependency-cruiser.cjs` |
| dependency-cruiser | Per-rule `to.pathNot` / `to.viaOnly` restriction, documented inline in the rule's `comment` | `.dependency-cruiser.cjs` |
| knip | `ignore` / `ignoreDependencies` | `knip.json` |

`scripts/__tests__/dependency-cruiser-graph-completeness.test.mjs` is a standing pin against a DIFFERENT failure shape than any row above: a file silently missing from the graph entirely (as opposed to a real, visible violation someone chose to tolerate). It asserts every `git ls-files`-tracked TS/TSX file under `packages/` resolves into dependency-cruiser's own module graph, against a small, independently-maintained exception list in the test itself (currently just `packages/server/vitest.config.ts`) — independent on purpose, so a future addition to `.dependency-cruiser.cjs`'s own `options.exclude.path` doesn't get an automatic pass from this pin too.

For each grandfathered entry, the config must answer:

- **Why is this exempt?** (e.g., "type-only back-edge between `session-manager` and its helpers.")
- **What would take it off the list?** (e.g., "extract file upload to `lib/file-upload.ts`.")

### Current baseline (as of this PR)

| Finding | Tool | Treatment | Follow-up |
|---------|------|-----------|-----------|
| `routes/workers.ts` imports `fs/promises` (file uploads) | dep-cruiser `no-fs-in-route-handlers` | `pathNot` exception in rule | Extract upload to `packages/server/src/lib/file-upload.ts` |
| `routes/worktrees.ts` imports `fs/promises` (`stat` for existence check) | dep-cruiser `no-fs-in-route-handlers` | `pathNot` exception in rule | Move to `packages/server/src/lib/path-validator.ts` |
| `routes/system.ts` imports `fs/promises` (editor-launch probes) | dep-cruiser `no-fs-in-route-handlers` | `pathNot` exception in rule | Wrap in a `lib/` helper alongside the `Bun.spawn` editor launcher |
| 3 client component cycles via barrel re-exports (`sessions/index.ts`, `worktrees/index.ts`, and `routes/__root.tsx` via `useCreateWorktree`) — all value-level edges, genuine runtime cycles | dep-cruiser `no-circular` | `.dependency-cruiser-known-violations.json` | Replace barrel imports with direct file imports |
| `packages/server/src/services/notifications/index.ts` barrel unused | knip | `ignore` in `knip.json` | Delete barrel; callers already import direct files |
| `packages/server/vitest.config.ts` | dep-cruiser + knip | excluded from scan / ignored | Delete; project uses `bun test`, not vitest |
| `class-variance-authority`, `@types/diff`, `happy-dom`, `mock-fs`, `@types/mock-fs` | knip | `ignoreDependencies` | Verify and remove unused packages; memfs has replaced mock-fs, and shadcn/cva is no longer in use |

**Not in this table on purpose:** `session-manager.ts <-> session-pause-resume-service.ts` has a type-only back-edge (`import type { WebSocketCallbacks }`) that used to be silently hidden by `madge`'s file-level exclusion (Issue #1487) and, before that fix, would otherwise have needed a baseline entry here once `no-circular` could see it. It doesn't need one: `no-circular`'s `viaOnly.dependencyTypesNot: ['type-only']` restriction (see the rule table above) means a cycle with a type-only edge in it is structurally not a violation, not a tolerated one. A prior version of this document also listed a second cycle through `session-converter-service.ts` — that file has no import back to `session-manager.ts` at all, so it was never actually part of a cycle; it was only ever excluded from `madge`'s graph defensively.

## Rationale for excluded checks

- **no-orphans (dep-cruiser)**: not configured. Dead-code detection is knip's domain; dep-cruiser's orphan rule requires maintaining large framework-entry allowlists (TanStack Router files, bun test auto-discovery) that drift out of date.
- **Bun.spawn**: cannot be detected by static import analysis because `Bun` is a global. Until direct callers are wrapped in a `lib/` helper, this must be caught manually in review. Preferred migration: every `Bun.spawn` site moves behind a typed wrapper (e.g., `lib/process-utils.ts`).

## Interpreting output

- **`error`** from dep-cruiser / knip fails CI. Fix or grandfather with an entry in this document.
- **`warn`** is informational. Check regularly; do not let it accumulate indefinitely.
- **Unresolvable import for `./routeTree.gen`**: normal when running tools before `vite build`. The CI workflow invokes `bun run --filter @agent-console/client build` first. Locally, run `bun run build` once if you hit it.

## Related

- Issue [#636](https://github.com/ms2sato/agent-console/issues/636) — introduction of this tooling.
- Issue [#1487](https://github.com/ms2sato/agent-console/issues/1487) — `madge`'s file-level exclusion silently blinded `lint:cycles`; `madge` was retired in favor of an edge-typed dependency-cruiser rule.
- Skill `.claude/skills/architectural-invariants/SKILL.md` — meta-invariants at the review layer; structural metrics enforce their mechanically-checkable subset.
