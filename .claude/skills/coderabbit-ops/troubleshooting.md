# CodeRabbit Ops — Troubleshooting / FAQ

Case-by-case dispositions for CodeRabbit issues. The 3-layer clean verdict definition, CLI invocation, and LOW / NITPICK findings policy live in [`SKILL.md`](SKILL.md); this file covers the exception paths.

## Q: The local CodeRabbit CLI is rate-limited. What do I do?

**Rate-limit fallback (closes Issue #653).** When the local CLI is rate-limited (typically 48-min wait window), proceed to PR creation, rely on the GitHub-side CodeRabbit bot review (separate token, runs on PR open), and add a note to the PR body:

```markdown
## Note on CodeRabbit
Local CodeRabbit CLI rate-limited during this sprint. Relying on GitHub-side CodeRabbit bot review.
```

Before merge, confirm the GitHub bot review is APPROVED. If `CHANGES_REQUESTED`, follow the resolution flow in [`.claude/skills/orchestrator/core-responsibilities.md`](../orchestrator/core-responsibilities.md) §6 (CodeRabbit "CHANGES_REQUESTED" resolution). (Sprint 2026-04-25 — verified in PRs #687 / #688 / #691 / #694.)

## Q: The local CLI won't run at all. Is it rate-limited, or is this the headless-worktree auth failure?

**Distinguish by the error shape — do not default to "rate-limited."** The local CodeRabbit CLI has two distinct failure modes that read differently and require different dispositions:

| Symptom | Cause | Disposition |
|---|---|---|
| Times out with no result, or replies `authentication_failed` / `automatic_login_failed` | **Headless-worktree auth failure.** `coderabbit review --agent` needs an interactive browser-based login; a delegated worktree session has no browser to complete it. This is a structural limitation of the session, not a quota condition, and will not resolve by waiting or retrying. | Skip the local CLI for this session. Rely on the GitHub-side bot review (per the rate-limit fallback note above), and record the auth-failure reason (not "rate-limited") in the PR body so the distinction is visible later. |
| Replies with an explicit rate-limit message naming a countdown (e.g. "next review available in: N minutes") | **True rate-limit.** The account's request quota is exhausted; the countdown is the real recovery time. | Follow the existing rate-limit fallback disposition (wait it out, or fall back to the GitHub bot per the sections above). |

Conflating the two in a PR body misleads whoever reads it later: an auth failure never self-resolves within the session (it needs a different environment, not more time), while a rate-limit does resolve after its countdown. State which one actually happened. (Sprint 2026-07-18b — PRs [#1204](https://github.com/ms2sato/agent-console/pull/1204), [#1207](https://github.com/ms2sato/agent-console/pull/1207), [#1208](https://github.com/ms2sato/agent-console/pull/1208), [#1209](https://github.com/ms2sato/agent-console/pull/1209), and [#1212](https://github.com/ms2sato/agent-console/pull/1212) all hit the headless-auth-failure shape rather than a true rate-limit; each PR body named the auth failure explicitly instead of defaulting to "rate-limited.")

## Q: The local CLI was clean. Can I trust the GitHub bot will be too?

**No. CLI and GitHub bot have independent review depth.** The local CodeRabbit CLI and the GitHub-side CodeRabbit bot run on separate tokens and likely separate prompts; their findings do not always overlap. A clean local CLI pass does not guarantee a clean bot review, and vice versa. Treat the bot as an additional layer of detection rather than a fallback.

**Do not merge while waiting for the bot review** — the rate-limit fallback note above defers merging only until the bot's APPROVED state is observable. (Sprint 2026-04-28 PR #711 — local CLI flagged 1 minor finding; the GitHub bot subsequently caught two Major findings the CLI had missed: an `await` propagation gap and a UTF-16 surrogate pair split. Both required follow-up commits before merge.)

## Q: The GitHub bot posted a rate-limit warning at PR open and hasn't reviewed since. Should I push a trivial commit to retrigger?

**No. Abandon the wait, do not over-engineer.** If the GitHub-side bot posts a rate-limit warning at PR open and a subsequent `@coderabbitai review` re-trigger does not produce a review submission within ~10-15 minutes, abandon the wait. CodeRabbit's "incremental review" policy can treat the rate-limit warning event as "already reviewed" and refuse to re-review the same commit. **Do not push trivial commits to force a re-trigger** — that bends the workflow around CodeRabbit's quirks at the cost of CI cycles and review log noise.

Instead, when the local CodeRabbit CLI is clean (0 findings), add the rate-limit fallback note (above) to the PR body, treat that as the documented exception path, and proceed to merge after the rest of the "clean" 3-layer condition is satisfied. (Sprint 2026-04-30 PR #738 — bot unresponsive 60+ min after re-trigger while PR #737 in the same flow returned APPROVED in 3 min; owner guidance: do not bend the process for CodeRabbit, abandon the wait early.)

## Q: I retriggered `@coderabbitai review` and got "Review finished... does not re-review already reviewed commits." Does that count as clean?

**Depends on what the existing walkthrough actually contains — check before treating the quirk reply as clean.** CodeRabbit's incremental-review policy replies with this message whenever it judges the current commit already reviewed, regardless of whether that prior review was a real code walkthrough or just a rate-limit notice. The reply text alone does not tell you which. Check the PR's actual state for the commit in question:

- **Walkthrough-exists rubric (treat as clean-equivalent):** a real walkthrough was posted for this commit (a genuine review comment, not just a rate-limit notice) **and** inline actionable comments = 0 **and** `reviewDecision` is empty. This combination means the bot reviewed the code, found nothing to flag, and simply did not submit a formal `APPROVED` event — a known CodeRabbit behavior for zero-finding passes, not an unreviewed state. Treat this as equivalent to a clean verdict; note the rubric explicitly in the PR body (see the disposition note template in the next Q).
- **Rate-limit-only walkthrough (NOT clean):** the only "walkthrough" content posted for this commit is a rate-limit message (e.g. "Review limit reached... next review available in: N minutes") with no actual code review. No real review ran for this commit — the quirk reply is masking an unreviewed state, not a reviewed-and-clean one. Do not treat this as clean; proceed to the "both channels unavailable" disposition below if the local CLI is also unavailable.

Verify which case applies by reading the PR's actual review comments and `reviewDecision` at decision time — do not infer cleanliness from the quirk reply's wording alone (this is the CodeRabbit-feedback instance of the Inference vs Verification rule in `workflow.md`).

## Q: Both the local CLI and the GitHub-side bot are rate-limited at the same time. CodeRabbit's verdict is unavailable. What do I do?

**Disposition follows existing PR Merge Authority — the simultaneous-rate-limit case removes only the CodeRabbit safety net.** When both layers are simultaneously rate-limited at the same time (no CodeRabbit feedback obtainable from either source), CodeRabbit's "clean" verdict is unavailable for that PR. Do not block the PR indefinitely. Disposition follows existing [PR Merge Authority](../orchestrator/SKILL.md#pr-merge-authority) — orchestrator-merge or owner-approval is decided there, not here.

Add this rate-limit-fallback note to the PR body so the documented exception path is visible to anyone reviewing the merge:

```markdown
## Note on CodeRabbit
Both local CodeRabbit CLI and GitHub-side bot were rate-limited at this PR's review window. No CodeRabbit feedback obtainable from either source. Merging under existing [PR Merge Authority](https://github.com/ms2sato/agent-console/blob/main/.claude/skills/orchestrator/SKILL.md#pr-merge-authority).
```

The simultaneous-rate-limit case does not relax PR Merge Authority — it removes only the CodeRabbit safety net. Owner approval thresholds for production code remain unchanged. (Sprint 2026-05-01 — observed across PRs #747 / #748 / #749 / #750: all four hit simultaneous rate-limit; orchestrator merged the docs PR (#747) and the test-only PR (#748) under PR Merge Authority, owner approved the process PR (#749) and the logic PR (#750). No regressions surfaced post-merge.)

## Q: Local CLI is a headless auth-fail AND the GitHub bot is rate-limited (or stuck on the "Review finished" quirk with no real walkthrough) — both channels are unavailable for the SAME commit. What do I do?

**Substitute verification layer: Architect independent audit + Orchestrator acceptance = dual-clean.** This differs from the plain "both simultaneously rate-limited" case above in one important way: a headless-worktree auth failure is a **structural** limitation, not a quota condition — it will not resolve by waiting. Where the rate-limit-both case can bridge with "wait for the countdown," this case has no such bridge on the local-CLI side. When this happens for a commit that has no real review from either channel:

1. **Confirm both channels are genuinely exhausted for this commit** — the local CLI failure is a headless auth-fail (per the first Q above, not a rate-limit you could wait out), and the GitHub bot is either rate-limited with a countdown, or stuck on the "Review finished" quirk with the rate-limit-only walkthrough (per the previous Q — not the walkthrough-exists clean-equivalent case).
2. **Check whether an earlier round already produced real CodeRabbit findings for this PR.** If a prior commit in the same PR got a genuine walkthrough (with real findings, fixed or disposed of with rationale), that round's verification still counts — the gap is specifically for the commits since then.
3. **Route the gap through the Architect as a third verification layer.** The Architect performs an independent code-appropriateness audit of the diff that lacks CodeRabbit coverage. This audit plus the Orchestrator's acceptance check form a **dual-clean gate** — both must be clean before merge. This is a substitute for CodeRabbit's verdict, not a waiver of review altogether.
4. **Merge under existing [PR Merge Authority](../orchestrator/SKILL.md#pr-merge-authority)**, same authority thresholds as the plain rate-limit-both case (orchestrator-merge vs owner-approval decided there, not here) — the dual-clean gate satisfies the "CodeRabbit clean" precondition, it does not change who is allowed to merge.

**Canonical PR body disposition note** (copy and fill in):

```markdown
## Merge disposition note (YYYY-MM-DD)

**CR state**: initial walkthrough at HH:MM was <rate-limit / clean>. Manual retry at HH:MM got <"Review finished" reply / new walkthrough>. inline: <N>, reviewDecision: <empty / APPROVED / CHANGES_REQUESTED>.

**Fallback disposition applied** (`coderabbit-ops` skill, <both-layer rate-limit / headless-auth-unavailable / Sprint YYYY-MM-DD quirk pattern>): <selected disposition>. Merging on architect + Orchestrator dual-clean per <owner directive reference>.
```

(Sprint 2026-07-18b — observed in PR [#1207](https://github.com/ms2sato/agent-console/pull/1207): round-1 findings were obtained and fixed via a genuine GitHub bot walkthrough, but round-2 verification of the fix commit was unobtainable from either channel — local CLI returned `automatic_login_failed` in the headless worktree, and the GitHub bot's retrigger returned the "Review finished... does not re-review already reviewed commits" quirk with no new walkthrough. The PR merged under this dual-clean disposition, citing PR Merge Authority. PR [#1212](https://github.com/ms2sato/agent-console/pull/1212) hit the adjacent variant: the original fix commit got a genuine clean walkthrough, but a test-only R1 delta then hit a GitHub-bot rate-limit; the Orchestrator's disposition substituted the architect's independent audit of the (test-only, low-risk) delta rather than waiting out the countdown. See also PRs [#1204](https://github.com/ms2sato/agent-console/pull/1204), [#1208](https://github.com/ms2sato/agent-console/pull/1208), [#1209](https://github.com/ms2sato/agent-console/pull/1209) for the single-channel variant — local CLI headless-auth-fail only, GitHub bot channel remained available and returned a clean review, so the dual-clean substitute was not needed there.)

## Q: All my review comments are addressed but `reviewDecision` is still `CHANGES_REQUESTED`. Can I merge?

**Yes — the stale `CHANGES_REQUESTED` is a GitHub UX gap, not a CodeRabbit refusal.** When CodeRabbit attaches a `<review_comment_addressed>` marker to a previously-flagged inline comment, the comment thread auto-closes (no further bot action expected on that line). However, GitHub's PR-level `reviewDecision` only updates when a new top-level review (`APPROVED` / `CHANGES_REQUESTED`) is submitted — addressing all individual comments does not flip the PR-level field on its own. CodeRabbit does not always submit a follow-up `APPROVED` review even after every comment is resolved, so the stale `CHANGES_REQUESTED` can persist indefinitely.

**Disposition before merge:**

1. **Verify each inline comment is resolved or marker-closed.** Run:
   ```
   gh api repos/<owner>/<repo>/pulls/<N>/comments --jq '[.[] | {body_first_120: .body[:120]}]'
   ```
   Confirm every CodeRabbit comment either is GitHub-resolved or contains the `<review_comment_addressed>` marker (or an equivalent "addressed" annotation from the bot).
2. **Check whether a newer review supersedes the `CHANGES_REQUESTED`.** Run:
   ```
   gh pr view <N> --json reviews,latestReviews
   ```
   If the latest review is `APPROVED`, the rollup field is just laggy and a UI refresh / `gh pr view` re-query usually flips it.
3. **If the latest review is still `CHANGES_REQUESTED` despite all comments resolved**, the bot has not submitted the follow-up positive review. Treat the 3-layer clean verdict as satisfied: pre-merge checks SUCCESS + 0 unresolved actionable inline comments + no outstanding CodeRabbit ask. The stale `reviewDecision` does not block merge under PR Merge Authority. Add a one-line note to the PR body / merge confirmation:
   ```
   CodeRabbit reviewDecision is `CHANGES_REQUESTED` (stale UX) — all comments are marker-closed; merging under existing PR Merge Authority.
   ```

(Lesson: Sprint 2026-05-10 PR #770 round 3 — CodeRabbit auto-closed all inline comments via `<review_comment_addressed>` markers but did not submit a top-level `APPROVED` review; PR-level `reviewDecision` remained `CHANGES_REQUESTED` despite every flagged item being resolved. Pushing a trivial commit to force a re-trigger would only burn CI cycles per the abandon-the-wait rule above.)

## Q: The local CLI is consistently catching issues before the GitHub bot. How should I use them together?

**Standard pattern: "CLI clean → wait for bot → APPROVED" two-phase verification.** Treat the local CLI as a fast first pass that catches most Major / actionable findings, and the GitHub bot as a slower confirmation layer. The bot's `reviewDecision: APPROVED` is the canonical clean signal, but the local CLI typically finishes well before the bot submits its review (especially when the bot is rate-limited and gradually recovers).

Recommended sequence per push:

1. **Run the local CLI** (`coderabbit review --agent --base main`). Address every CRITICAL / HIGH / MEDIUM finding. Re-push if you make code changes from CLI feedback.
2. **Wait for the GitHub-side bot review.** It may take 3-12 minutes typically, longer under rate-limit. Do not push trivial commits to retrigger (per "abandon-the-wait" above).
3. **Merge when `reviewDecision: APPROVED` and CLI is clean.** Both layers form the 3-layer clean verdict.

This pattern is robust against the GitHub bot being temporarily rate-limited: the CLI gives you a verifiable clean signal you can act on while the bot recovers. When the bot eventually submits, it serves as confirmation rather than the only data point. (Lesson: Sprint 2026-06-26 — observed across PRs #892 / #897. Both pushed multiple times during a CodeRabbit rate-limit window; CLI ran clean on every push and caught Major findings the bot would later have flagged. The bot's APPROVED arrived after rate-limit lifted, confirming the CLI verdict. Without the CLI pass, both PRs would have been merge-blocked on the bot's rate-limit recovery or proceeded with no review at all.)

## Q: `mergeStateStatus: BLOCKED` despite all checks SUCCESS and reviewDecision APPROVED. Why can't I auto-merge?

**This is the main-branch signature ruleset, not a CodeRabbit issue.** Production main has a branch-protection ruleset that requires signed commits via a "signature" required check. PRs created by the orchestrator / agents through `gh pr create` do not satisfy that ruleset, so `mergeStateStatus` reports `BLOCKED` even when CI is green and the review is APPROVED.

**Scope of the BLOCKED state.** The signature ruleset fires for PRs that touch production code paths. Docs-only, test-only, and skill/rule/agent-only PRs frequently come back as `mergeStateStatus: CLEAN` even though they were created by the same `gh pr create` path. Do not assume `BLOCKED` is the universal post-CI state — observe the rollup before reaching for `--admin`. (Lesson: Sprint 2026-06-27 PR #907 — a test-only consolidation PR was reported as `CLEAN` immediately after CI green, with no signature ruleset firing; the orchestrator's pre-merge guidance to the agent had assumed `BLOCKED` per the production-code precedent and warned about `--admin`, which turned out to be unnecessary. The agent's retro flagged the over-broad guidance, leading to this scoping note.)

**Resolution when BLOCKED actually fires: use `gh pr merge <N> --admin --squash` (owner action).** The `--admin` flag bypasses the signature requirement for the merge commit. Orchestrator can squash-merge docs / test-only PRs under PR Merge Authority; production code requires owner approval before the orchestrator passes the merge instruction.

Do NOT interpret `mergeStateStatus: BLOCKED` as a CI failure or a CodeRabbit reject. Check the rollup, the `reviewDecision`, and the inline comments first; if those are all clean and `BLOCKED` is the only remaining signal, the signature ruleset is the cause. (Lesson: Sprint 2026-06-26 PR #897 — both Wave A PRs reported `mergeStateStatus: BLOCKED` throughout the review cycle despite all CI checks passing; owner used `--admin` flag to merge. New orchestrators discover this only when surprised by the persistent BLOCKED state; documenting here saves the discovery cost.)
