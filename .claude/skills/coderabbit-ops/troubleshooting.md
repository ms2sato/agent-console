# CodeRabbit Ops — Troubleshooting / FAQ

Case-by-case dispositions for CodeRabbit issues. The 3-layer clean verdict definition, CLI invocation, and LOW / NITPICK findings policy live in [`SKILL.md`](SKILL.md); this file covers the exception paths.

## Q: The local CodeRabbit CLI is rate-limited. What do I do?

**Rate-limit fallback (closes Issue #653).** When the local CLI is rate-limited (typically 48-min wait window), proceed to PR creation, rely on the GitHub-side CodeRabbit bot review (separate token, runs on PR open), and add a note to the PR body:

```markdown
## Note on CodeRabbit
Local CodeRabbit CLI rate-limited during this sprint. Relying on GitHub-side CodeRabbit bot review.
```

Before merge, confirm the GitHub bot review is APPROVED. If `CHANGES_REQUESTED`, follow the resolution flow in [`.claude/skills/orchestrator/core-responsibilities.md`](../orchestrator/core-responsibilities.md) §6 (CodeRabbit "CHANGES_REQUESTED" resolution). (Sprint 2026-04-25 — verified in PRs #687 / #688 / #691 / #694.)

## Q: The local CLI was clean. Can I trust the GitHub bot will be too?

**No. CLI and GitHub bot have independent review depth.** The local CodeRabbit CLI and the GitHub-side CodeRabbit bot run on separate tokens and likely separate prompts; their findings do not always overlap. A clean local CLI pass does not guarantee a clean bot review, and vice versa. Treat the bot as an additional layer of detection rather than a fallback.

**Do not merge while waiting for the bot review** — the rate-limit fallback note above defers merging only until the bot's APPROVED state is observable. (Sprint 2026-04-28 PR #711 — local CLI flagged 1 minor finding; the GitHub bot subsequently caught two Major findings the CLI had missed: an `await` propagation gap and a UTF-16 surrogate pair split. Both required follow-up commits before merge.)

## Q: The GitHub bot posted a rate-limit warning at PR open and hasn't reviewed since. Should I push a trivial commit to retrigger?

**No. Abandon the wait, do not over-engineer.** If the GitHub-side bot posts a rate-limit warning at PR open and a subsequent `@coderabbitai review` re-trigger does not produce a review submission within ~10-15 minutes, abandon the wait. CodeRabbit's "incremental review" policy can treat the rate-limit warning event as "already reviewed" and refuse to re-review the same commit. **Do not push trivial commits to force a re-trigger** — that bends the workflow around CodeRabbit's quirks at the cost of CI cycles and review log noise.

Instead, when the local CodeRabbit CLI is clean (0 findings), add the rate-limit fallback note (above) to the PR body, treat that as the documented exception path, and proceed to merge after the rest of the "clean" 3-layer condition is satisfied. (Sprint 2026-04-30 PR #738 — bot unresponsive 60+ min after re-trigger while PR #737 in the same flow returned APPROVED in 3 min; owner guidance: do not bend the process for CodeRabbit, abandon the wait early.)

## Q: Both the local CLI and the GitHub-side bot are rate-limited at the same time. CodeRabbit's verdict is unavailable. What do I do?

**Disposition follows existing PR Merge Authority — the simultaneous-rate-limit case removes only the CodeRabbit safety net.** When both layers are simultaneously rate-limited at the same time (no CodeRabbit feedback obtainable from either source), CodeRabbit's "clean" verdict is unavailable for that PR. Do not block the PR indefinitely. Disposition follows the existing PR Merge Authority (see [`.claude/skills/orchestrator/core-responsibilities.md`](../orchestrator/core-responsibilities.md)):

- docs-only / test-only / pure-refactor PRs → orchestrator may merge after CI is green and acceptance check passes
- logic / process / config-change PRs → owner approval required, as always

Add this rate-limit-fallback note to the PR body so the documented exception path is visible to anyone reviewing the merge:

```markdown
## Note on CodeRabbit
Both local CodeRabbit CLI and GitHub-side bot were rate-limited at this PR's review window. No CodeRabbit feedback obtainable from either source. Merging under existing PR Merge Authority (docs-only / test-only / pure-refactor → orchestrator merge / logic / process / config → owner approval).
```

The simultaneous-rate-limit case does not relax PR Merge Authority — it removes only the CodeRabbit safety net. Owner approval thresholds for production code remain unchanged. (Sprint 2026-05-01 — observed across PRs #747 / #748 / #749 / #750: all four hit simultaneous rate-limit; orchestrator merged the docs PR (#747) and the test-only PR (#748, an `__tests__/` directory migration with no production code change despite the `chore:` commit prefix) under PR Merge Authority, owner approved the process PR (#749) and the logic PR (#750). No regressions surfaced post-merge.)
