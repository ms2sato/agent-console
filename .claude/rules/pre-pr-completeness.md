# Pre-PR Completeness Gap-Scan

Before opening a PR that introduces a **new skill, script, rule, file type, or canonical procedure**, walk this 5-question mechanical checklist. Each question should take 30 seconds to 2 minutes. If any answer is "unsure", resolve before pushing.

## The five questions

1. **Does a similar existing mechanism already exist?**
   - `ls` the relevant directories (`.claude/rules/`, `.claude/skills/`, `.claude/skills/orchestrator/`, `scripts/`, `packages/*/src/`)
   - `grep -r` for keywords from the proposal (concept name, file pattern, command)
   - Read any file that looks relevant, even briefly
   - If a similar mechanism exists: is this new thing a genuine extension, a replacement, or a duplicate? Duplicate → stop and reuse. Extension → cross-link. Replacement → document migration.
   - **1.5 (cross-doc citation sub-check):** When this PR cites another document's technical claim (schema, API, command behaviour), verify the claim against the actual code, not just the other document. Documents describe intent; code describes reality. When the two drift, cite the code's current state. (Lesson: Sprint 2026-04-20 PR #677 claimed `multi-user-shared-setup.md` "declared REFERENCES users(id)"; CodeRabbit caught that migration v14 shipped without the REFERENCES DDL. The design doc described the spec; the code did something different.)
2. **Is the invocation or trigger of this new thing documented in a canonical procedure?**
   - If it is a script or a skill that needs to run at a specific point, find where that point is described (e.g., `core-responsibilities.md §N`, `sprint-lifecycle.md`, or equivalent)
   - Add the invocation instruction there in the same PR
   - A future Orchestrator or agent that follows the canonical procedure must be able to execute this new thing without reading the PR description
3. **If this has tests, are failure paths tested?**
   - Unit tests: happy path + at least one failure / edge case (empty input, invalid input, boundary value)
   - Integration tests where applicable per `test-trigger.md`
   - "What happens when the underlying call fails silently" is a common blind spot — ask it explicitly
4. **If this adds a new file type or directory, is the full lifecycle (create / read / update / delete / rename / archive) documented in a README or skill?**
   - Who creates it, when? Who reads it, when?
   - What moves it (accept / reject / archive)?
   - What should never be done to it (e.g., "never silently delete rejected entries")?
5. **Rule clarity pass — for PRs that introduce or substantially modify rule text:**
   - Read each clause as a fresh reader who has never seen the codebase. Would they apply the rule mechanically without further context?
   - Prefer concrete examples or file paths over abstract verbs ("check file X" beats "verify appropriately").
   - Remove prediction-framed statements (e.g., "X will fade") — rules describe what to do, not what the ecosystem will become.

## When to apply

- **Required** for PRs that introduce:
  - A new script in `.claude/skills/**` or `scripts/**`
  - A new rule in `.claude/rules/**` or skill in `.claude/skills/**`
  - A new directory under `docs/` or `.context-store/` (or similar infrastructure)
  - A new canonical procedure step (e.g., new subsection in `core-responsibilities.md §N`)
- **Optional but encouraged** for any production code PR touching infrastructure or cross-cutting patterns
- **Not required** for single-file bug fixes, typo corrections, or test-only additions

## Why

The Orchestrator's self-review is calibrated for *content correctness* (does the code do what it claims?). It is structurally weak on *completeness* ("what else should also be here?"). Both substantive defects surfaced in Sprint 2026-04-18 — the initial `file-test-map.md` proposal duplicating existing `test-trigger.md`, and the missing Post-Merge Flow `§7f` trigger documentation for the brewing system — were caught by the owner, not by self-review. A mechanical checklist converts the owner-catch burden into a self-catch habit.

Cross-reference: `memory/feedback_check_existing_before_proposing.md` captured the first incident as a single-case reminder; this rule generalizes it into a process gate.

## How this rule is expected to decay

As the Orchestrator develops completeness instincts, these questions may become automatic and the explicit checklist may be retired. Until then, apply mechanically rather than skipping on the assumption that the answer is obvious.
