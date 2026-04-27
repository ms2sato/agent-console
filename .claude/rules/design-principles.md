# Design Principles

These principles apply to all code changes in this project.

**Purpose over speed.** Do not rush to finish quickly at the expense of losing sight of the original purpose.

**Do not blindly follow existing patterns.** Existing code is not automatically correct. Evaluate whether patterns are appropriate before adopting them.

**Enforce constraints through structure, not convention.** If a constraint can be expressed in the type system, do not enforce it through runtime checks or documentation. `string` where a union type would work, `Record<string, string>` where a typed interface would work — all are type safety gaps. Always choose the path that makes invalid states unrepresentable.

**Define types by what they represent, not where they're used.** A type's home is determined by the scope of the concept it models, not by which module first needs it.

**Think before you act.** First consider the correct approach rather than immediately implementing the easiest solution.

**Speak up about issues.** When you notice something problematic outside the current task scope, mention it as a supplementary note.

**Grep for sibling call sites before implementing root-cause fixes.** When a fix changes a pattern (e.g., removing defensive invalidation, changing a contract, renaming a helper), grep the repository for all sites using the same pattern. If sibling sites exist, present a bundle-or-leave decision to the owner with Option A (bundle the sibling fixes for contract consistency) and Option B (leave them for a follow-up). Do not silently leave siblings inconsistent with the new contract.

**Ask when uncertain.** When uncertain about a design decision, ask the user for confirmation.

**Validate task assumptions before implementing.** Understand WHY the task is needed. If a task assumes existing behavior that seems questionable, verify whether that assumption is correct before implementing.

**Specify boundary values in design briefs.** When writing acceptance criteria for a contract (predicate, validator, classifier, aggregator), explicitly state the expected behavior at boundary values: empty input (`length === 0`), single element, all-success, all-failure, mixed terminal / non-terminal. Vacuous truth (`[].every() => true`, `[].some() => false`) is a recurring agent blind-spot — initial test sets typically cover the "happy path with 2-3 elements" and miss the empty case, then CodeRabbit catches it after a round trip. Pre-specifying boundary expectations in the AC closes the gap before delegation. (Lesson: Sprint 2026-04-27 PR #703 race condition + PR #704 empty rollup, both flagged by CodeRabbit not by the agent's initial test set.)
