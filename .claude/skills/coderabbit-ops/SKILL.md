---
name: coderabbit-ops
description: CodeRabbit code review operations playbook + troubleshooting / FAQ. Use when creating a PR, before merge, when handling CodeRabbit issues (rate-limit fallback, GitHub-side bot unresponsive, both layers simultaneously rate-limited), or when interpreting the CodeRabbit verdict surfaces (pre-merge checks / reviewDecision / inline comments / commit-status description / formal review bodies). Covers local CLI invocation, GitHub-side bot interpretation, and case-by-case dispositions.
---

# CodeRabbit Ops

This skill is the operational playbook for **CodeRabbit code review** in this project. It covers CLI invocation, the LOW / NITPICK findings policy, and the verdict-surface checklist (the single writer for that list). For case-by-case dispositions (rate-limit fallback, unresponsive bot, simultaneous rate-limit), see [`troubleshooting.md`](troubleshooting.md).

## When to invoke

- **PR creation** — to know how to run the local CLI and how to address findings.
- **Before merge** — to walk the verdict-surface checklist.
- **CodeRabbit troubleshooting** — when the local CLI is rate-limited, the GitHub-side bot is unresponsive, both channels are simultaneously rate-limited, or the verdict surfaces disagree.
- **CI failure diagnosis** — when CodeRabbit-related checks fail and you need the resolution flow.

## CLI invocation

Execute `coderabbit review --agent --base main` and address any **CRITICAL / HIGH / MEDIUM** severity issues before creating a PR. If the CodeRabbit CLI is not installed locally, skip this step and recommend installation:

```bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
```

## LOW / NITPICK findings policy

Read every finding regardless of severity. For LOW / NITPICK / "minor" findings:

- **Address inline if the fix is cheap** (1-2 lines, no behaviour change, reduces future ambiguity).
- **Defer with a one-line note in the PR body** when the fix is non-trivial or out of scope — name the finding and the reason for deferral so the owner can override. Silent skip is not acceptable.
- **Never mark "addressed" without a code change or an explicit defer note.** "I read it and decided it's fine" is not closure; the absence of either a fix commit or a defer note hides the trade-off.

## CodeRabbit verdict surfaces (checklist)

GitHub scatters CodeRabbit information across several unrelated surfaces. **Every surface below must be checked** before merge — none of them alone is the verdict, and a clean-looking subset is the recurring way findings get missed.

This section is the **single writer** for the surface list. Other documents (`workflow.md`, `core-responsibilities.md`) link here rather than restating it; when a new surface is discovered, add it here only.

One thing that looks like a surface and is not: a **future-tense reply from the bot** ("I will review …"). See "Not a surface" below before counting it as anything.

> **Why this section is not called "the N-layer verdict" anymore.** It was "the 3-layer clean verdict" for months, then a 4th surface was documented in a separate subsection, and then a 5th (below) was found the hard way — a Major finding sat in a place none of the named layers read, on a PR both the Orchestrator and the Architect had already called clean. A name that encodes a count asserts completeness the list does not have, and invites checking "the three" and stopping. Treat the list as open: the next surface is not yet in it.

| # | Surface | Verification | Clean state |
|---|---|---|---|
| 1 | **Pre-merge checks** (Title / Description / Docstring / Linked Issues / Out-of-Scope) | "5/5 passed" in the GitHub UI | Metadata validation only — **not** code review |
| 2 | **Review state** | `gh pr view <N> --json reviewDecision` | `APPROVED` (or empty under the rate-limit fallback in `troubleshooting.md`) |
| 3 | **Inline comments** | `gh api repos/<owner>/<repo>/pulls/<N>/comments` | Resolved or addressed if actionable |
| 4 | **Commit-status `description`** | see "The commit-status surface" below | `Review completed` — `state` is `success` even when no review ran |
| 5 | **Formal review bodies** | see "The review-body surface" below | No unaddressed findings in any review's `body` |

An empty `reviewDecision` means the bot has not yet reviewed and the PR is **not** yet clean — wait for the bot to submit, do not merge. (Exception 1: under the rate-limit fallback in `troubleshooting.md`, an empty state may persist; in that exception path, follow the fallback's verification steps before merge. Exception 2: a completed walkthrough with 0 actionable inline comments can also leave `reviewDecision` empty — CodeRabbit does not always submit a formal review event when it finds nothing to flag. See "the walkthrough-exists rubric" in `troubleshooting.md` before assuming "not yet reviewed" from an empty field alone.)

**Docs-only PR carve-out (by configuration).** `.coderabbit.yaml` sets `reviews.auto_review.ignore_title_keywords: ["docs:"]`, so PRs titled with the conventional `docs:` prefix are skipped by auto-review ON PURPOSE (quota preservation — docs-only PRs were rate-limiting code PRs during PR-dense sprints). For such PRs an empty `reviewDecision` with no bot activity is the EXPECTED state, not a wait condition: verify the diff is genuinely docs-only (no production code), then treat surface 2 as N/A. When a docs PR warrants a bot pass anyway (e.g. a large design doc), trigger one manually with an `@coderabbitai review` comment — the manual path is unaffected by the title skip. Note the file also carries the review profile (`chill`) previously configured in the web UI, because a repo config file takes precedence over UI settings.

"CodeRabbit clean" requires every surface. Pre-merge checks alone are insufficient. (Sprint 2026-04-25 PR #694 — agent declared "clean" based on pre-merge 5/5 while review state was `CHANGES_REQUESTED` with 3 actionable issues.)

### The commit-status surface: `statusCheckRollup`'s `CodeRabbit` entry is NOT a verdict

None of surfaces 1-3 is the **commit-status context** named `CodeRabbit`. That context nonetheless appears in `gh pr view <N> --json statusCheckRollup` — the command everyone runs to confirm CI — rendered alongside `test`, `preflight`, and the rest as:

```
CodeRabbit=SUCCESS
```

`gh pr checks <N>` renders the same underlying status worse still, as the bare word **`pass`**:

```
CodeRabbit	pass	0		Review rate limited
```

The description is sitting right there in the next column, and it still gets read as a verdict — because `pass` is the vocabulary of the row above it and the row below it, where it does mean "this check succeeded". Two delegates on 2026-08-20 independently reported "CodeRabbit: rate-limited, treated as pass", each having copied that column's word into a list of green checks. Neither ran `gh pr view --json reviewDecision`. **`gh pr checks` cannot express the CodeRabbit verdict at all** — it collapses commit-status `state` into one word and shows neither `reviewDecision` nor any review body. Seeing the `CodeRabbit` row there is a signal to go read surfaces 2-5, never a substitute for them.

**Its `state` is `success` regardless of whether a review happened.** The truth is in the `description`, which `statusCheckRollup` does not surface by default. Read it explicitly:

```bash
SHA=$(gh pr view <N> --json headRefOid -q .headRefOid)
gh api repos/<owner>/<repo>/commits/$SHA/status \
  -q '[.statuses[] | select(.context=="CodeRabbit") | "\(.state) | \(.description) | \(.updated_at)"] | .[0]'
```

Descriptions observed, all with `state=success`:

| `description` | Meaning | Action |
|---|---|---|
| `Review completed` | A real review ran | Proceed to surfaces 2, 3 and 5 |
| `Review rate limited` | **The bot never reviewed this commit** — and this may not be the whole reason; see below | Re-read against the comment body before deciding to wait |
| `Review skipped: N files exceed the limit of 100` | **Structural.** The PR is over the plan's file cap and waiting will never clear it | Reduce the diff (see `troubleshooting.md`); no disposition can substitute for a review that cannot start |
| `Review skipped: ignored keyword in the PR title` | Deliberately skipped by `.coderabbit.yaml` config (the `docs:` carve-out above) | Surface 2 is N/A — verify the diff really is docs-only |

Note the `updated_at` too: the status is re-issued per head SHA, so **updating a PR branch resets it**. A `Review completed` from before a rebase says nothing about the current head.

**`Review rate limited` does not mean "wait and it will open".** A round the quota blocked can only report the quota; a *structural* skip beneath it (the file cap, a title keyword) is invisible from that round's status. The two look identical and only one clears with time.

Two ways to the real reason: **read the bot's issue comment body**, which names a structural reason outright even while the status still says rate-limited, or **retrigger** with `@coderabbitai review` and re-read the description, which self-corrects once a round actually attempts the review.

**Their agreement is the signal you have reached the true reason — and the stopping condition.** Without it there is no principled point at which to stop reading.

(Lesson: Sprint 2026-08-28 PR [#1403](https://github.com/ms2sato/agent-console/pull/1403) — 107 files, 7 over the cap. The status read `Review rate limited` for over an hour while the bot's own comment named the file count; the Orchestrator was telling the delegate to wait for a window that could never open. A first generalisation, "the description misreports the reason", was then narrowed by measurement: at 16:55 both said the file cap, at 17:36 both said the quota. The description is not unreliable — it is silent about whatever the blocked round never got far enough to see.)

**This is `workflow.md` Sub-pattern 7 (stale state carried across idle) wearing a CodeRabbit costume, and it is easiest to miss on the *last* push.** Once a genuine review has landed mid-PR, "CodeRabbit is handled for this PR" quietly becomes a background fact, and the next push is evaluated on CI alone. The re-read discipline is not "check the description once per PR" but **"check it for the head you are about to merge"** — including a head whose only change is a test, and including a head you pushed yourself thirty seconds ago.

Two shapes to watch for, both observed on the same PR:

- **The review you remember was of an earlier commit.** Read the walkthrough's own scope line — it states the range explicitly (`Reviewing files that changed from the base of the PR and between <sha> and <sha>`). If that range ends before your current head, the commits in between are unreviewed no matter how thorough the review you are remembering was.
- **The commits most likely to go unreviewed are the fix commits responding to the review itself** — which is exactly the diff a second pass is worth most on, since it was written under the pressure of a finding.

(Lesson: Sprint 2026-08-16 PR [#1304](https://github.com/ms2sato/agent-console/pull/1304) — a real review landed at `bc418377`; three commits followed, two of them the fixes for that review's own findings. The rollup read `CodeRabbit=SUCCESS` throughout while the description read `Review rate limited`. The delegate had correctly re-read the description after each of the first two pushes and reported honestly, then skipped it on the third after mentally filing CodeRabbit as resolved. Retriggering once the repository-wide window reopened produced a genuine review of exactly that range with no actionable comments — so the gap cost one wait, not a fallback disposition.)

(Sprint 2026-07-18b — three PRs (#1227, #1231, #1229) carried `CodeRabbit=SUCCESS` in the rollup while the description read `Review rate limited`. Reading only the rollup state would have merged all three as "CodeRabbit clean" with no review. #1227 in particular later produced a Major finding that a standards document would otherwise have shipped with.)

### The review-body surface: findings that live in no inline comment

A finding CodeRabbit cannot anchor to a changed line — GitHub rejects inline comments outside the diff — is posted in the **body of the formal review** instead. Nothing about it appears in the inline-comment list, so surface 3 reports zero and surface 4 reports `Review completed`: the PR looks reviewed and clean while carrying an unread finding.

Read every review body explicitly:

```bash
gh api repos/<owner>/<repo>/pulls/<N>/reviews \
  -q '.[] | "\(.submitted_at) \(.user.login) \(.state)\n\(.body)"'
```

The tell in the body is a `⚠️ Outside diff range comments (N)` block. Its findings carry the same severity markers as inline ones and must be dispositioned the same way — fixed, or deferred with a note.

**Zero inline comments is not evidence of zero findings.** When surface 3 comes back empty, that is precisely when surface 5 must be read, not when the check is over.

(Sprint 2026-08-05 PR #1276 — CodeRabbit posted a formal review whose body held a Major finding: session-resume rollback freed PTY workers but not the embedded-agent worker the same change had just activated, leaking a subprocess and a minted MCP token that became unreachable once the session was deleted. `reviewDecision` was empty, inline comments were 0, and the commit status said `Review completed`. The Orchestrator reported "findings zero" to the owner on that basis; the Architect's independent audit had also missed the rollback asymmetry. It surfaced only because the delegate re-examined the CodeRabbit state on their own initiative and reported the ambiguity rather than accepting the Orchestrator's summary. A process that depends on a delegate doubting the Orchestrator is not a process — this section is what replaces it.)

### Not a surface: a future-tense reply from the bot

Every surface in the checklist is **state** — a status, a review decision, a comment list, a review body, a walkthrough. When you retrigger with `@coderabbitai review`, the bot may also answer conversationally, and that reply is none of those things:

> `@user`, I will review the current head of #NNNN, including the `compact()` commit-point change and the four implemented dispositions.

**A future-tense reply is an acknowledgement that a command was received. It is not evidence that a review ran — it is closer to evidence that one has not.** When it arrives while the commit status still reads `Review rate limited`, it confirms the limit rather than reporting progress against it. Only the artifacts of a *completed* review count toward a verdict: a formal review body, inline comments, or an actual walkthrough update.

The danger is social rather than technical, and it is worse than the `SUCCESS` false-clean for that reason. `SUCCESS` has to be misread. A sentence naming the exact change you are waiting on, in the first person, reads as a commitment — and a commitment is the easiest thing in this whole list to relay upward as progress. "The bot said it will review the commit-point change" is a sentence someone can say in good faith while nothing has happened.

The rule is the same one that governs the rest of this list, applied to a surface that talks back: **check the state, not the promise.**

(Sprint 2026-08-29 PR #1415 — a delegate retriggered against the current head. The bot replied within ninety seconds naming the specific change it would review; the commit status updated fourteen seconds after that to `Review rate limited`, and the walkthrough comment, updated in the same minute, said the included review was spent with the next one 35 minutes out. The delegate reported the disagreement between the bot's two mouths rather than the reply, explicitly flagging that "the bot said it would review" was the thing most likely to be passed upward as progress. The Orchestrator confirmed they would have relayed exactly that had they seen only the reply.)

### Two ways the query itself lies to you

Both produce a confident, wrong "there is nothing there", and both were hit in one sitting on a PR whose walkthrough did exist:

- **The login is `coderabbitai[bot]`.** `select(.user.login == "coderabbitai")` returns empty and reads as "the bot posted nothing". Use `startswith`.
- **Walkthrough bodies are long.** `head -N` truncates *inside the first comment*, so a later one never appears. Filter by author, not by line count.

```bash
gh api repos/<owner>/<repo>/issues/<N>/comments --paginate \
  --jq '.[] | select(.user.login | startswith("coderabbitai")) | .body'
```

An empty result from a broken query is indistinguishable from a real absence — and "the bot posted no walkthrough" is odd enough to send you investigating the bot rather than the query. **Confirm an absence with a differently-shaped second query before believing it.**

## Case-by-case dispositions

For the following situations, see [`troubleshooting.md`](troubleshooting.md):

- **Local CLI rate-limited** (typically 48-min wait window) → Rate-limit fallback (CLI side)
- **Local CLI won't run at all — is it rate-limited or a headless-worktree auth failure?** → Headless auth-fail vs rate-limit
- **CLI clean, bot finds Major issues anyway** → CLI vs bot independent depth
- **GitHub bot unresponsive after rate-limit warning** → abandon-and-proceed policy
- **GitHub bot replies "Review finished... does not re-review already reviewed commits" after a retrigger** → the "Review finished" quirk
- **Both local CLI and GitHub bot simultaneously rate-limited** → PR Merge Authority disposition
- **Local CLI headless auth-fail AND GitHub bot rate-limited/quirked at the same time** → Architect + Orchestrator dual-clean disposition
- **CodeRabbit `CHANGES_REQUESTED` resolution** → see [`.claude/skills/orchestrator/core-responsibilities.md`](../orchestrator/core-responsibilities.md) §6
