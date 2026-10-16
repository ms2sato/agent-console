# Surface-by-Operation Decision Table

An undecided spec point that reaches an implementer becomes a decision the implementer did not know they were making. This rule makes every such point visible before dispatch, as a table whose every cell is a recorded decision.

## Why this rule exists

TODO list v1 (2026-10-15/16): the design doc's UI section said the session panel lists items and the `/todos` page "hosts the add and delete controls", and said nothing about where resolve and dismiss live. The implementer read that as "resolve and dismiss live on `/todos` only" and built a read-only panel. Every clause of the AC passed; the owner found the gap in dogfood ("can't the status be changed from the sidebar?"). The owner named the root cause: an undecided point was left to the implementer, and no role had a duty to notice before dispatch. Q11.5 (`pre-pr-completeness.md`) already enforces this shape for `AGENT_OPERATIONS` with types; this rule is the same idea for every feature, at the document level, where types cannot reach.

## Trigger (the class, not the instance)

A design doc or AC that names **two or more surfaces** (a page, a panel, a sidebar, an MCP tool, a REST route, an embedded-agent-visible surface, a CLI) and **one or more operations** on the same objects (create, list, read, edit, resolve, dismiss, delete, assign, ...). A single-surface feature is not exempt from deciding: it records one line, "operation X is exposed only on surface Y because Z". A PR with no operation on any surface (pure refactor, infrastructure) is out of scope and says so.

## The table

Rows are operations; columns are surfaces. Every cell holds exactly one of:

- `do: <where>` -- the component, tool name or route that exposes it;
- `not here: <one-line reason>` -- a decision not to expose it on this surface. "Later" is a decision only when it names the follow-up Issue; without one it is undecided;
- `?` -- undecided. Allowed ONLY in a draft on its way to the owner. **Zero `?` cells at dispatch.**

An operation named anywhere in the AC or the doc but absent from the table is an undecided cell. The table lives in the design doc's Surfaces section (the single copy); the AC carries one checklist line pointing at it (below). When user-facing columns exist (UI), the owner confirms those cells before dispatch, and the table records `owner-confirmed <date>`.

## Roles

1. **AC author (the Architect).** Writes the table with the AC; decides every cell; marks the user-facing cells for owner confirmation; never leaves a cell to the implementer. The Q13 self-pass (`pre-pr-completeness.md`) includes: "is there a cell I am leaving to the implementer?". The AC's checklist carries: `- [ ] Decision table in <doc> section N has no undecided cell; the implementation matches every "do" cell and exposes nothing marked "not here".`
2. **Orchestrator, BEFORE dispatch.** Locate the table. Count `?` cells, and operations named in the AC or the design doc that have no row. If either count is non-zero: do not dispatch; return the AC to its author, or ask the owner for the user-facing cells, and record the answer in the doc. Pasting an AC is not reading it; this check is what reading it means here.
3. **Implementer, DURING implementation.** A decision the code forces that the table does not make (a missing cell, a surface the doc forgot, a reader the AC anchored wrong) is a STOP: hold, consult the Orchestrator (who routes to the Architect or the owner), and the decision is written back into the design doc in the same PR BEFORE the code that depends on it. Worked example: Issue #2038 (2026-10-16): the AC anchored a server reader that PTY workers never use; the delegate measured it in Browser QA before push, held, the ruling was corrected, and the corrected mechanism landed in the doc with the code. A blocker found here is a finding, not an obstacle (`pre-pr-completeness.md` Q12 says the same for verifications).
4. **Acceptance check.** `acceptance-check.js` Q14 asks two questions: are there undecided cells or operations in the code with no cell, and did the implementer make a decision the table and AC do not contain (compare the diff's surfaces against the table). Either is a HOLD: the decision goes back to the author or the owner and into the doc, then the PR proceeds.

## Boundary cases

- An operation exposed on no surface at all (data model only) still gets a row: every cell `not here` with the reason, or it is not a feature yet.
- A surface added later (a new page, a new MCP tool) adds a column, and every existing row gets a decision in the same PR (this is Q11.5's "new surface adds a table" rule, generalised).
- A `not here` cell whose reason has expired (the follow-up landed, the constraint is gone) is a drift finding for the next PR that touches the row, not a silent re-decision by an implementer.

## Cross-references

- `pre-pr-completeness.md` Q11.5 -- the type-enforced instance for `AGENT_OPERATIONS` (`docs/design/agent-surface.md` Mechanism 3); Q13 -- the author's self-pass that now includes the table.
- `.claude/skills/orchestrator/core-responsibilities.md` section 3 -- the pre-dispatch step.
- `.claude/skills/orchestrator/acceptance-check.js` Q14 -- the audit-side question.
- `.claude/skills/architect/SKILL.md` "AC authoring discipline" -- the author's bullet.
- First application: `docs/design/human-todo-list.md` section 4 (TODO list v2).
