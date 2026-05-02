---
date: 2026-04-30
importance: medium
nature:
  - insight
tags:
  - boundary-values
  - tdd
  - structural-defect
  - implementation-probe
related_rules:
  - .claude/rules/design-principles.md
  - .claude/rules/workflow.md
related_issues:
  - "#730"
  - "#737"
summary: |
  Empty-`PATH` boundary test caught `cat <<EOF` failing exactly where the
  diagnostic was supposed to work (PATH-less environments). Boundary values
  are not just inputs — they probe for invisible implementation-environment
  dependencies. `printf` is a bash builtin; `cat` is not.
read_when:
  - Writing boundary-value tests for predicates / contracts / fail-fast diagnostics
  - Implementing diagnostics that must run in minimal / degraded environments
---

# The empty PATH boundary that found a structural defect

## What happens (first-person, present tense)

Sprint 2026-04-30, the second task of two. PR #737 is a P0 hot-fix: agent-console's `enforce-permissions.sh` (a `PreToolUse` hook installed in the previous sprint) requires `jq`, and on a fresh clone without `jq` the hook fail-closes on every `Bash | Read | Write | Edit` invocation. The agent literally cannot self-recover. The fix is a `SessionStart` hook that surfaces the diagnostic before the deadlock can happen.

The agent — delegated from the Orchestrator session — writes the test first, per `workflow.md` TDD-for-bug-fixes. The test is straightforward: simulate `jq` missing by setting `PATH=/nonexistent`, assert the hook exits non-zero with an actionable message. The implementation is a heredoc:

```bash
cat <<EOF >&2
check-prerequisites: jq is required by .claude/hooks/enforce-permissions.sh...
EOF
exit 1
```

The happy-path test passes. Then the agent decides — almost as an afterthought — to also test the **empty `PATH`** case. Just to be thorough. `PATH=""`. Same expectation: non-zero exit, diagnostic on stderr.

The test fails. Not the way one expects — `cat: command not found`. The diagnostic itself never reaches stderr.

The realization is immediate. `cat` is not a bash builtin. With `PATH=""`, the shell cannot resolve `cat` — and the entire diagnostic vanishes. The hook's *purpose* is to surface a clear error in exactly this kind of minimal environment. The implementation — `cat <<EOF` — fails *most loudly precisely where it most needs to work*.

The fix is one word: `printf`. `printf` is a bash builtin. It runs even when `PATH` cannot resolve any external command. The test passes; the contract holds.

## Why it matters (emotion labels)

- **Quiet relief**: this would have shipped without the empty-PATH test. The hook would have been documented as "addresses the deadlock" and would have been worse than nothing in the actual deadlock environment — the user would see no diagnostic at all, just denial.
- **Surprise at the structural depth**: I expected the boundary test to be a pro-forma exercise — "yes, empty input also handled". Instead it found a load-bearing assumption (the implementation depends on `cat` being on `PATH`) that no amount of staring at the code would have surfaced. The test wasn't checking input handling; it was checking the implementation's environmental dependencies.
- **Recognition that the rule's framing was incomplete**: `design-principles.md` "Specify boundary values" focused on *vacuous-truth* failures (`[].every() === true`). That is one boundary failure mode. This is a different one: **the boundary value reveals what the implementation depends on**. Empty input is not just an input — it is a probe for invisible assumptions.
- **A small awe at the discipline**: the agent did not need to be reminded to add the empty-PATH test. The discipline of "boundary values are mandatory" had landed enough to be reflexive.

## What I want to be true (for future Orchestrator instances and agents)

When you write a boundary test for a contract, do not think of it only as "input coverage". Think of it as a **probe**: what does this minimal input reveal about my implementation's hidden dependencies?

- A test with empty *input* asks "what does my code do with nothing?"
- A test with empty *environment* (empty PATH, empty filesystem, empty config) asks "what does my code *need* that I haven't named?"

Both are boundary tests. Both are mandatory. The second is the rarer use, and the more revealing one.

When you reach for `cat`, `awk`, `sed`, `tr` in a script that runs early in a process lifecycle (SessionStart hooks, init scripts, recovery paths), pause and ask: *can I express this with a builtin?* `printf`, `[[ ]]`, parameter expansion, `read` — these run when external commands cannot be resolved. The cost of using a builtin is small; the cost of depending on `cat` in a deadlock-recovery script is total.

## On the mechanism itself (meta)

The discipline that produced this discovery is a chain:

- `design-principles.md` says specify boundary values
- The agent's delegation prompt repeats the boundary-values mandate
- The agent writes the empty-PATH test as a routine extension, not a special case
- The test fails, surfacing the structural defect

No single point in the chain is novel — but the chain delivered a finding that ad-hoc review would not. This is the model the catalog and the rules are built around: not "be clever", but "make the discipline reflexive enough that it catches structural bugs incidentally". Today it caught one.

## Honest limits

- The agent did not initially document *why* it added the empty-PATH test in its retrospective — only *that* the test caught the issue. The reasoning behind "I'll add an empty-PATH case" is the part I am reconstructing here. If the agent had not added that test, this narrative would not exist; the bug would have shipped quietly. The discipline is reflexive when it works, but its origins are still discretionary — a future agent could decide "the empty PATH case is silly" and skip it. The rule needs to be strong enough that this decision feels wrong.
- "Boundary tests are probes" is a frame, not a checklist. It will not be applied mechanically. It is a way of seeing — and like all narratives, it relies on a future reader being willing to read it instead of skim it.

## Sibling rule / next step

- `architectural-invariants/SKILL.md` "How to Use" item 4 was added in the same sprint retrospective: walk the catalog against Issue alternatives, not just chosen implementations. That rule and this narrative point in the same direction: *do not trust acceptability claims (from Issues, from past selves, from common sense) without the discipline's own probe*.
- `design-principles.md` "Specify boundary values" remains the prescriptive entry point. This narrative is the background for *why the rule exists in this exact phrasing* — and an extension of its scope from "vacuous truth" to "implementation-structure probe".
