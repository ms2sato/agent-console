# Workflow Rename Delegation Template

Use when delegating a rename of a CI workflow file
(`.github/workflows/*.yml`).

## Paste this block into "Key Implementation Notes"

### Workflow Rename Specific Guidance

Renaming a workflow is a semantic change that touches every reference to
the old name. Walk this checklist:

1. **Rename the file.** `.github/workflows/[OLD].yml` →
   `.github/workflows/[NEW].yml`. Update the `name:` field at the top of
   the file too if it still mentions the old name.

2. **Cross-runtime spawn check.** If the workflow invokes a script that
   spawns another runtime (`spawn('bun', ...)`, `spawn('node', ...)`),
   verify the workflow installs the spawn target (`setup-bun`,
   `setup-node`). Per `.claude/rules/pre-pr-completeness.md` Question 6.

3. **Repository-wide grep — update every hit.**
   ```bash
   git grep -l "[OLD-NAME]" .github/ docs/ .claude/ CLAUDE.md README.md
   ```
   Hits typically include:
   - Documentation under `docs/**/*.md`
   - Rule and skill files under `.claude/rules/**` and `.claude/skills/**`
   - `CLAUDE.md`
   - README badges (URL paths and shield labels)

4. **Branch protection rules.** Branch protection on `main` may require
   the OLD workflow name as a "required check". GitHub will treat the
   renamed workflow as a brand-new check that has not yet passed. The
   sequence is:
   - Push the rename PR (CI runs the new name once on the PR's branch).
   - Owner updates branch protection rules to use the new name.
   - Then merge is allowed.

   Surface this to the Orchestrator before pushing so the owner can be
   notified of the protection-rule update.

### Self-check before PR

- [ ] Old workflow file no longer exists at the old path.
- [ ] New workflow file runs cleanly on the rename PR's CI.
- [ ] `git grep "[OLD-NAME]"` returns 0 hits in `docs/`, `.claude/`,
      `CLAUDE.md`, `README.md`.
- [ ] Cross-runtime spawn check (`pre-pr-completeness.md` Question 6) holds.
- [ ] Branch protection rules update has been requested via the
      Orchestrator.

(Lesson: Sprint 2026-04-29 PR #726 — renaming `coverage-check` →
`preflight` required updating not just the workflow yml but multiple
references across `.claude/skills/orchestrator/` and `CLAUDE.md`. The
4-step checklist captures the cross-cutting nature of CI workflow
identity.)
