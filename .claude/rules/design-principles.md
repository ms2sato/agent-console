# Design Principles

These principles apply to all code changes in this project.

**Purpose over speed.** Do not rush to finish quickly at the expense of losing sight of the original purpose.

**Do not blindly follow existing patterns.** Existing code is not automatically correct. Evaluate whether patterns are appropriate before adopting them.

**Enforce constraints through structure, not convention.** If a constraint can be expressed in the type system, do not enforce it through runtime checks or documentation. `string` where a union type would work, `Record<string, string>` where a typed interface would work — all are type safety gaps. Always choose the path that makes invalid states unrepresentable.

**Define types by what they represent, not where they're used.** A type's home is determined by the scope of the concept it models, not by which module first needs it.

**Think before you act.** First consider the correct approach rather than immediately implementing the easiest solution.

**Speak up about issues.** When you notice something problematic outside the current task scope, mention it as a supplementary note.

**Ask when uncertain.** When uncertain about a design decision, ask the user for confirmation.

**Validate task assumptions before implementing.** Understand WHY the task is needed. If a task assumes existing behavior that seems questionable, verify whether that assumption is correct before implementing.
