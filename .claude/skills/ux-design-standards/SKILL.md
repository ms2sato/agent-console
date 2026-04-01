---
name: ux-design-standards
description: UX design principles for agent-console. Use when designing features, evaluating acceptance criteria, or reviewing user-facing interactions in a multi-agent management UI.
---

# UX Design Standards

Five principles for a multi-agent management UI where one user orchestrates many parallel AI agents.

## Principles

### 1. Sequential Flow Over Hub-and-Spoke
Process multiple items in sequence (A → done → B) instead of forcing return to a central hub between each item. Example: Review Queue (#405) — owner reviews one PR then advances to the next without returning to a queue list.

### 2. Parallel Awareness Without Parallel Attention
Surface state changes passively (badges, activity indicators, memos) without requiring active monitoring. Pull, not push — no popups for routine updates. Example: Session sidebar shows agent state (idle/active/asking) via color-coded indicators; agents write memos the user reads asynchronously.

### 3. Interruption Hierarchy
Distinguish urgency: **Blockers** (agent asking question, error) → prominent indicator, unmissable from any screen. **Action needed** (PR ready, acceptance done) → badge on next glance. **Informational** (task completed, CI passed) → passive, on demand. Completions are not blockers.

### 4. Action Proximity
Actions available where the user already is — inline over page-level, contextual creation, progressive disclosure. Example: Worktree creation from session breadcrumb (#402) — no navigation to a management page.

### 5. Glanceable Status, Opt-in Detail
Summaries in lists, full detail on click. Summarize semantically ("Agent completed PR #42"), not by truncation. Two-level pattern: Level 1 = summary in lists, Level 2 = detail on expand. Example: Session sidebar shows name, state icon, and memo preview without terminal output.

## Applying to Acceptance Criteria

When writing criteria for user-facing features, verify each principle:
- "User can process items sequentially without returning to the list" (P1)
- "State change visible from session list without opening the session" (P2)
- "Blocker visually distinct from completion" (P3)
- "Action available inline without page navigation" (P4)
- "Status understandable from list view without expanding" (P5)

See [ux-design-standards.md](ux-design-standards.md) for full rationale, design guidelines, and codebase examples.
