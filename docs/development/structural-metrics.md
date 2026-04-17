# Structural Metrics

Tooling for **structural** cohesion/coupling review — the part of code quality you can evaluate from the dependency graph alone, without domain knowledge.

- `dependency-cruiser` — forbidden-import rules (layer boundaries, deep imports, I/O localization, circular deps).
- `knip` — dead code (unused files, exports, dependencies).
- `madge` — circular dependency detection + graph visualization.

`bun run lint` is the recommended single command — it runs the full structural lint suite. Individual entries remain for targeted runs.

```bash
bun run lint              # alias for lint:structure (recommended)
bun run lint:structure    # dep-cruiser + madge + knip
```

Or individually:

| Command | Purpose |
|---------|---------|
| `bun run lint:deps` | dependency-cruiser against baseline (`--ignore-known`) |
| `bun run lint:deps:all` | dependency-cruiser, including known violations |
| `bun run lint:deps:baseline` | regenerate `.dependency-cruiser-known-violations.json` |
| `bun run lint:cycles` | madge circular detection (excludes via `.madgerc`) |
| `bun run lint:cycles:all` | madge without the grandfathering excludes |
| `bun run lint:unused` | knip dead-code / unused-deps |
| `bun run graph:deps` | render the dependency graph to `dependency-graph.svg` (requires Graphviz `dot`) |

> **Note.** ESLint is not currently installed in this project. When it is introduced, add a `lint:eslint` script and chain it from the `lint` umbrella (e.g., `"lint": "bun run lint:eslint && bun run lint:structure"`) so both style and structural checks run under the same command.

CI runs all three on every PR — see `.github/workflows/structural-metrics.yml`.

## What each tool does

### dependency-cruiser

Enforces architectural rules encoded in `.dependency-cruiser.cjs`. Rules are named and commented; the config file is the spec.

Current rule set (small and deliberately meaningful):

| Rule | What it prevents |
|------|------------------|
| `no-circular` | Runtime circular dependencies (type-only cycles are ignored). |
| `client-no-runtime-import-from-server` | Client bundles must not pull server source at runtime. Type-only import from `@agent-console/server/api-type` is the sanctioned RPC contract. |
| `server-no-import-from-client` | Server must not depend on client. Shared code belongs in `packages/shared`. |
| `no-deep-import-into-shared` | Consumers of `packages/shared` use the package entry (`index.ts`), not internal subpaths. |
| `no-fs-in-route-handlers` | `routes/`, `middleware/`, `websocket/` must not touch `fs`/`fs/promises` directly. The I/O surface lives in `lib/` or services. |
| `no-process-spawn-in-route-handlers` | Same shape for `child_process`. (`Bun.spawn` is a global — reviewers still need to watch it manually until we wrap it.) |
| `no-reverse-dep-service-to-delivery` | Services must not import from `routes/` or `websocket/`. Delivery depends on services, not the other way around. |
| `not-to-unresolvable` | Catches dangling imports. |
| `no-duplicate-dep-types` | Dependency listed twice (dev + regular). |

### madge

Used in CI as a second-opinion circular detector. Unlike dep-cruiser it does not distinguish `import type` from runtime `import`, so it catches structural cycles that are "erased at compile time" but still exist in the source AST. See `.madgerc` for the current grandfathered list.

For local exploration:

```bash
bunx madge --image dependency-graph.png --extensions ts,tsx packages
```

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
| madge | `excludeRegExp` in `.madgerc` | `.madgerc` |
| knip | `ignore` / `ignoreDependencies` | `knip.json` |

For each grandfathered entry, the config must answer:

- **Why is this exempt?** (e.g., "type-only back-edge between `session-manager` and its helpers.")
- **What would take it off the list?** (e.g., "extract file upload to `lib/file-upload.ts`.")

### Current baseline (as of this PR)

| Finding | Tool | Treatment | Follow-up |
|---------|------|-----------|-----------|
| `routes/workers.ts` imports `fs/promises` (file uploads) | dep-cruiser `no-fs-in-route-handlers` | `pathNot` exception in rule | Extract upload to `packages/server/src/lib/file-upload.ts` |
| `routes/worktrees.ts` imports `fs/promises` (`stat` for existence check) | dep-cruiser `no-fs-in-route-handlers` | `pathNot` exception in rule | Move to `packages/server/src/lib/path-validator.ts` |
| `routes/system.ts` imports `fs/promises` (editor-launch probes) | dep-cruiser `no-fs-in-route-handlers` | `pathNot` exception in rule | Wrap in a `lib/` helper alongside the `Bun.spawn` editor launcher |
| 3 client component cycles via barrel re-exports (`sessions/index.ts`, `worktrees/index.ts`, and `routes/__root.tsx` via `useCreateWorktree`) | dep-cruiser `no-circular` + madge | `.dependency-cruiser-known-violations.json` + `.madgerc` `excludeRegExp` | Replace barrel imports with direct file imports |
| 2 server type-only cycles (`session-manager ↔ session-pause-resume-service`, `session-manager ↔ session-converter-service`) | madge only (dep-cruiser ignores type-only back-edges) | `.madgerc` `excludeRegExp` | Extract shared types to a neutral module so the back-edge disappears |
| `packages/server/src/services/notifications/index.ts` barrel unused | knip | `ignore` in `knip.json` | Delete barrel; callers already import direct files |
| `packages/server/vitest.config.ts` | dep-cruiser + knip | excluded from scan / ignored | Delete; project uses `bun test`, not vitest |
| `class-variance-authority`, `@types/diff`, `happy-dom`, `mock-fs`, `@types/mock-fs` | knip | `ignoreDependencies` | Verify and remove unused packages; memfs has replaced mock-fs, and shadcn/cva is no longer in use |

## Rationale for excluded checks

- **no-orphans (dep-cruiser)**: not configured. Dead-code detection is knip's domain; dep-cruiser's orphan rule requires maintaining large framework-entry allowlists (TanStack Router files, bun test auto-discovery) that drift out of date.
- **Bun.spawn**: cannot be detected by static import analysis because `Bun` is a global. Until direct callers are wrapped in a `lib/` helper, this must be caught manually in review. Preferred migration: every `Bun.spawn` site moves behind a typed wrapper (e.g., `lib/process-utils.ts`).

## Interpreting output

- **`error`** from dep-cruiser / knip / madge fails CI. Fix or grandfather with an entry in this document.
- **`warn`** is informational. Check regularly; do not let it accumulate indefinitely.
- **Unresolvable import for `./routeTree.gen`**: normal when running tools before `vite build`. The CI workflow invokes `bun run --filter @agent-console/client build` first. Locally, run `bun run build` once if you hit it.

## Related

- Issue [#636](https://github.com/ms2sato/agent-console/issues/636) — introduction of this tooling.
- Skill `.claude/skills/architectural-invariants/SKILL.md` — meta-invariants at the review layer; structural metrics enforce their mechanically-checkable subset.
