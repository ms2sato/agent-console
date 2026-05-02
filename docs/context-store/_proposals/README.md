# Context Store — Proposals (Architectural Invariant brewing drafts)

This directory holds **draft proposals** for new entries in `.claude/skills/architectural-invariants/SKILL.md`.

Proposals are written by a Claude session (typically the Orchestrator, or a sub-agent dispatched for brewing) after evaluating a merged PR against the rubric in `.claude/skills/brewing/SKILL.md`.

## Lifecycle

1. **Generation** — `node .claude/skills/orchestrator/brew-invariants.js <PR>` prints structured brewing context to stdout. The invoking Claude applies the brewing rubric to that context and, if warranted, writes a proposal file here.
2. **Review** — Owner / CTO reads proposals and decides accept / reject.
3. **Accept** — Owner edits `.claude/skills/architectural-invariants/SKILL.md` to add the new `I-N` entry (using the proposal as a draft). The proposal file is then deleted.
4. **Reject** — Move the file to `../_rejected/` with an appended `## Reject Reason` section. Reject reasons themselves formalize tacit knowledge about "why this is not an invariant".
5. **Backtest counterfactual (persistent)** — A proposal file may also represent a brewing recall test: "if we removed I-N from the catalog, would brewing reproduce it from the source PR's context?" These files are not pending review; they are validation evidence and **persist indefinitely** in this directory. They are identified by `status: proposed-backtest-counterfactual` in front-matter and a `backtest_note` field explaining the counterfactual setup. Steps 2-4 above do not apply to them. Tooling that walks `_proposals/` (e.g., the brewing rubric's "grep `_proposals/` and `_rejected/` for the candidate slug" anti-pattern check) should treat these files as informational, not as pending proposals. Example: [`I-7-value-shape-exhaustiveness-pr638.md`](I-7-value-shape-exhaustiveness-pr638.md) — generated 2026-04-18 as the Pilot's recall validation; `brewing-log.md` §1 Case 1b records the comparison against the real I-7.

## Naming

`I-<next>-<slug>-pr<PR>.md`

- `<next>` — the next free invariant number at proposal time (e.g., if the catalog has I-1..I-7, next is I-8). The accepted number may differ if multiple proposals land concurrently.
- `<slug>` — 2-5 lowercase words, hyphen-separated, summarizing the invariant.

## Frontmatter

Each proposal file starts with:

```yaml
---
proposed_id: I-<next>
slug: <short-name>
source_pr: <PR number>
source_issue: <Issue number if any>
brewed_at: YYYY-MM-DD
brewed_by: <Claude model or session id>
status: proposed
---
```

## Do not delete

Never delete proposals directly from this directory without either accepting (move content into the catalog) or rejecting (move to `../_rejected/`). Silent deletion loses brewing signal.
