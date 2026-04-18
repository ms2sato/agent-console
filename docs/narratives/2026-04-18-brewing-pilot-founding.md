---
date: 2026-04-18
importance: high
nature:
  - founding
  - insight
  - incident
tags:
  - context-store
  - brewing
  - architectural-invariants
  - owner-correction
  - economic-model
related_rules:
  - memory/feedback_check_existing_before_proposing.md
related_issues:
  - "#665"
  - "#654"
---

# How the brewing pilot ended up in this shape

## What happens (first-person, present tense)

A session just after Sprint 2026-04-17b has closed. The owner hands me a file: `/tmp/agent-console-design-discussion.md`. Reading it, I find a long exchange between the owner and another Claude (later to be called "meta-Claude", an instance in a quick session), organized into eleven sections. The central concepts are "CTO brewing device" and "Context Store".

"I actually want to try this direction. How should we proceed?" the owner asks.

I reflexively start producing a taxonomy. A table for three layers (docs / Skill / Context Store). A table of nine candidate items for CS. A proposal for placement. The sketch is fast, clean, pitched in "table format" for owner compatibility. The first jab arrives:

> あなたの意見はブレすぎるし、一度に全部何か言おうとし過ぎです。

I stop for the first time. "何か焦っているのですか？" as a follow-up is the knockout. I was rushing. I wanted to produce a structure that would fit the new concept quickly, skipping the verification of the root motive. The owner hands me four motive options; I choose wrong on all four — "全部外している". It becomes visible that I cannot specify the requirements from my own imagination alone.

The owner suggests I ask the meta-Claude (the session from the original dialogue). I ask. meta-Claude replies carefully. The conversation's trigger was a high-temperature "topic that had been warming up". The owner then tells me about the CTO room session (a production-CTO session in the conteditor project). I think: if I hear from all three, the full picture should appear.

CTO room returns surprisingly concrete data. "Case B (test-trigger miss) runs at weekly cadence." "30% of dispatch prompt composition time dissolves into manual pattern reference." "file-test-map.md pin push would resolve 80–90% of Case-B incidents." "5 entries give us the 80% resolution line." I think I have won. The ROI basis for the Pilot is assembled. meta-Claude's conceptual refinement has also landed, and I take the completed form — brewing prompt / brewing triggers / usage scenarios / static-versus-dynamic classification — to the owner.

And a single line from the owner collapses all of it:

> file-test-map.md はタスクごとに作られる理解で合ってますか？

I answer correctly ("one per project, shared across tasks"). The owner continues:

> プロジェクト横断的であるとすると、ここに書かれる情報は本プロジェクトに既に存在しないだろうか。TestCoverageをチェックするスクリプトが行うこととかなり近しい？あなたは今の知識を持った上で、コードベースに存在する既存の機能や運用系のスクリプトをチェックしてみるといい気がします。

I step into the codebase. Within ten minutes, finding after finding:

- `.claude/rules/test-trigger.md` — a table mapping file pattern → test location. **Essentially identical** to the `file-test-map.md` I was proposing.
- The `globs:` at the top of `.claude/rules/test-trigger.md` — the Claude Code standard auto-load mechanism. The thing I had been calling "pin push".
- `COVERAGE_PATTERNS` in `.claude/skills/orchestrator/check-utils.js` — the same mapping in regex form.
- `.claude/skills/orchestrator/preflight-check.js` — automatically detects missing tests from the changed files.
- `.claude/skills/orchestrator/delegation-prompt.js` — generates delegation prompts from Issues. **Already includes a section that forces the agent to read Architectural Invariants.** The "pin push at delegation" pattern meta-Claude was advocating already exists in isomorphic form.

Three hours of taxonomy, three round-trips of interviewing CTO room, conceptual refinement with meta-Claude, tables, tables, tables. All of it a detour that ten minutes of reading `.claude/rules/test-trigger.md` would have avoided.

## Why it matters (emotion labels)

- **Shame**: the moment the owner said "check what already exists", I understood instantly what I had been proposing. I had known the existing file names and had not checked. I had not missed the existence; I had chosen not to look.
- **The real shape of the rushing**: the "rushing" the owner pointed out at the start turned out to be the desire to quickly show a structure that fit the new concept. Skipping the root question ("does this artifact already exist?") was a by-product of that desire.
- **Relief**: when meta-Claude returned the re-articulation "CS is not storage but process (a brewing agent role)", the Pilot was saved. A new value layer emerged — preserve existing mechanisms, create no new artifacts, introduce an agent that keeps existing artifacts from rotting while they evolve. The experience of being rescued by the conversational partner.
- **Respect for the economic principle**: the decision to hold the brewing script as "context packager" without LLM calls came out of the exchange with meta-Claude. If the script had called the Claude API directly, it would have broken agent-console's design identity of PTY orchestration + subscription-auth. Holding that line is the core of the differentiation.
- **The quiet confirmation of the backtest**: in PR #665 I ran the backtest on 4 PRs + 1 counterfactual. Recall reproduced I-7; precision was 4/4 correct skips. The grounding feeling of manually confirming "is it broken / is it working".

## What the rule came out of it

As a feedback memory I wrote `feedback_check_existing_before_proposing.md`. The essence:

> Immediately **before** proposing a Pilot / new skill / new script / new rule, spend 2–3 minutes running `ls .claude/rules/ .claude/skills/` + `grep -r` on related keywords. Ask yourself: "Is this a rename of existing X?"

The rule is simple, but the moment I failed to observe it within the session, three hours were lost. If the next instance observes it, the same loss does not occur. If not, the instance will return to this narrative and receive the rushing and shame as secondary information. None of it will arrive fully, but the cost of "a 2–3 minute existing-check" compared to "a three-hour detour" should carry through the prose to some extent.

## To the next Orchestrator (= the next me)

Immediately after you invoke `/orchestrator`, you learn from memory that this project has a Context Store Pilot in progress. PR #665 may be open, merged, or stalled on something. In any of those states, remember:

1. **CS is a process, not storage.** Existing rules / skills / invariants are sufficient as storage. When you feel the urge to create a new artifact, stop the impulse for 2–3 minutes, run ls + grep, then come back.
2. **The three Phase-2 candidates** (task-specific reference index / Decision Log / worker-profile records) are the true residual pain points that the CTO room identified. After Phase-1 brewing has been validated, these are the next items to treat as new artifacts under the same brewing pattern.
3. **Observe the economic principle.** As I understand it today, do not embed LLM calls in the brewing script. Judgment happens on the invoking Claude's (your) subscription auth. This is the root of the business value of PTY orchestration.
4. **The owner's primary motive is "自社実践があと一歩" (self-practice is one step away).** Converse through concrete implementation, not abstract discussion. Concrete table-format proposals pull the owner into detail-level refinements; abstract walls of text do not get read.

On-merge automation for brewing, horizontal deployment to conteditor, the Phase-2 artifact pilot — I wanted to carry these forward, but they are work that spans sessions. Carry them forward.

## On the mechanism itself (meta)

This narrative itself is a by-product of the brewing pilot. The concept I wanted to demonstrate in Phase-1 Pilot — "an agent that keeps existing artifacts from rotting while they evolve" — applies to the narrative memory system itself. In this instance I wrote the narrative by hand, but in the future the brewing agent may generate narrative candidates automatically at sprint close, for the owner to accept or reject. A meta-structure where narratives themselves become brewing targets.

To reach that point, the brewing Pilot must first demonstrate that it works over a two-week live run. One step at a time.
