---
name: coderabbit-ops
description: CodeRabbit code review operations playbook + troubleshooting / FAQ. Use when creating a PR, before merge, when handling CodeRabbit issues (rate-limit fallback, GitHub-side bot unresponsive, both layers simultaneously rate-limited), or when interpreting the 3-layer clean verdict (Pre-merge checks / reviewDecision / inline comments). Covers local CLI invocation, GitHub-side bot interpretation, and case-by-case dispositions.
---

# CodeRabbit Ops

This skill is the operational playbook for **CodeRabbit code review** in this project. It covers CLI invocation, the LOW / NITPICK findings policy, and the 3-layer clean verdict. For case-by-case dispositions (rate-limit fallback, unresponsive bot, simultaneous rate-limit), see [`troubleshooting.md`](troubleshooting.md).

## When to invoke

- **PR creation** — to know how to run the local CLI and how to address findings.
- **Before merge** — to verify the 3-layer clean verdict.
- **CodeRabbit troubleshooting** — when the local CLI is rate-limited, the GitHub-side bot is unresponsive, both layers are simultaneously rate-limited, or the verdict layers are confusing.
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

## 3-layer clean verdict

GitHub surfaces CodeRabbit info in three distinct layers that are easy to confuse. **All three must be clean** before merge:

| Layer | Verification | Clean state |
|---|---|---|
| **Pre-merge checks** (Title / Description / Docstring / Linked Issues / Out-of-Scope) | "5/5 passed" in the GitHub UI | Metadata validation only — **not** code review |
| **Review state** | `gh pr view <N> --json reviewDecision` | `APPROVED` (or empty under the rate-limit fallback in `troubleshooting.md`) |
| **Inline comments** | `gh api repos/<owner>/<repo>/pulls/<N>/comments` | Resolved or addressed if actionable |

An empty `reviewDecision` means the bot has not yet reviewed and the PR is **not** yet clean — wait for the bot to submit, do not merge. (Exception: under the rate-limit fallback in `troubleshooting.md`, an empty state may persist; in that exception path, follow the fallback's verification steps before merge.)

"CodeRabbit clean" requires all three. Pre-merge checks alone are insufficient. (Sprint 2026-04-25 PR #694 — agent declared "clean" based on pre-merge 5/5 while review state was `CHANGES_REQUESTED` with 3 actionable issues.)

## Case-by-case dispositions

For the following situations, see [`troubleshooting.md`](troubleshooting.md):

- **Local CLI rate-limited** (typically 48-min wait window) → Rate-limit fallback (CLI side)
- **CLI clean, bot finds Major issues anyway** → CLI vs bot independent depth
- **GitHub bot unresponsive after rate-limit warning** → abandon-and-proceed policy
- **Both local CLI and GitHub bot simultaneously rate-limited** → PR Merge Authority disposition
- **CodeRabbit `CHANGES_REQUESTED` resolution** → see [`.claude/skills/orchestrator/core-responsibilities.md`](../orchestrator/core-responsibilities.md) §6
