---
name: ux-design-standards
description: UX design principles for agent-console. Use when designing features, evaluating acceptance criteria, or reviewing user-facing interactions in a multi-agent management UI.
---

# UX Design Standards

## Key Principles

- **Sequential flow over hub-and-spoke** - Process multiple items in sequence (A -> done -> B) instead of forcing return to a central hub
- **Parallel awareness without parallel attention** - Surface state changes passively; don't require active monitoring of each session
- **Interruption hierarchy** - Distinguish urgency levels: blockers need immediate attention, completions can wait
- **Action proximity** - Make actions available where the user already is, not on a separate page
- **Glanceable status, opt-in detail** - Show summarized state at a glance; detailed investigation is opt-in via click

## Detailed Documentation

- [ux-design-standards.md](ux-design-standards.md) - Full principles with rationale and codebase examples
