# UX Design Standards

This document defines UX design principles for agent-console. The product manages multiple AI coding agents through a browser UI. The primary user (CTO/orchestrator) monitors and controls parallel agent work. These principles guide feature design decisions.

## Context

Agent-console is not a typical single-task application. The user orchestrates multiple AI agents working in parallel across different git worktrees. This creates unique UX challenges:

- The user cannot watch all agents simultaneously
- State changes happen asynchronously across many sessions
- Decisions and blockers need timely attention, but most updates do not
- The user frequently switches between high-level overview and deep investigation

---

## Principle 1: Sequential Flow Over Hub-and-Spoke

### Statement

When processing multiple items (reviews, notifications, approvals), provide sequential navigation (A -> done -> B -> done) instead of forcing return to a central hub between each item.

### Rationale

Hub-and-spoke forces unnecessary navigation: view list -> select item -> act -> return to list -> select next item -> act -> return to list. Each return-to-hub step is cognitive overhead and wasted clicks. Sequential flow reduces this to: act on A -> next -> act on B -> next -> done.

### When to Apply

- Review queues where the user processes items one by one
- Notification lists requiring acknowledgment or action
- Any workflow where the user will likely process all (or most) items in order

### When NOT to Apply

- When items are independent and the user cherry-picks which to act on
- When the user needs the full list context to decide what to do next

### Codebase Examples

- **Review Queue (#405)**: Designed with sequential owner review flow. The owner reviews one PR, then advances to the next without returning to a queue list.

---

## Principle 2: Parallel Awareness Without Parallel Attention

### Statement

Users manage multiple agents simultaneously. The UI must surface state changes (badges, activity indicators, memos) without requiring active monitoring of each session. Notifications should be passive until the user looks.

### Rationale

The user cannot watch all agent sessions at once. The UI must work like a dashboard — the user glances at it periodically and immediately sees which sessions need attention. Information should come to the user, not require the user to go find it.

### When to Apply

- Session list and sidebar: show activity state (idle, active, asking) per session
- Memos: agents write memos that the user reads when ready
- Badges and indicators: unread counts, state change markers

### Design Guidelines

- **Pull, not push**: Do not interrupt the user with popups or modals for routine updates. Use visual indicators (badges, color changes, icons) that the user notices on their next glance.
- **Aggregate wisely**: If 5 agents complete within a minute, show "5 completions" rather than 5 individual notifications.
- **Persist until acknowledged**: State indicators should remain visible until the user has seen them. Do not auto-dismiss important state changes.

### Codebase Examples

- **Activity indicators**: Session sidebar shows agent state (idle/active/asking) via color-coded indicators
- **Memo system**: Agents write structured memos via `write_memo` MCP tool; the user reads them asynchronously

---

## Principle 3: Interruption Hierarchy

### Statement

Not all notifications are equal. Blockers and decisions need immediate attention; status updates and completions can wait until the user checks. The system must distinguish urgency levels.

### Rationale

Treating all events equally leads to either notification fatigue (everything alerts) or missed blockers (nothing alerts). A clear hierarchy ensures the user's attention is directed proportionally to urgency.

### Urgency Levels

| Level | Examples | UI Treatment |
|-------|----------|-------------|
| **Blocker** | Agent asking a question, approval required, error requiring intervention | Prominent visual indicator, consider sound/toast |
| **Action needed** | PR ready for review, acceptance check complete | Badge or indicator, visible on next glance |
| **Informational** | Agent completed task, CI passed, memo updated | Passive indicator, available on demand |

### When to Apply

- Designing any notification or state change indicator
- Deciding whether something deserves a toast, badge, or just a log entry
- Prioritizing what appears in a summary view vs. detail view

### Design Guidelines

- **Blocker signals must be unmissable**: If an agent is blocked waiting for user input, this must be visible from any screen, not just when viewing that session.
- **Completions are not blockers**: An agent finishing its work is good news that can wait. Do not treat it with the same urgency as an agent that is stuck.
- **Allow user-configured thresholds**: As the system matures, users may want to adjust what counts as each urgency level.

---

## Principle 4: Action Proximity

### Statement

Actions should be available where the user already is, not on a separate page. Reduce navigation distance between recognizing a need and acting on it.

### Rationale

Every page navigation is a context switch. If the user sees a session needs a worktree but must navigate to a separate "create worktree" page, they lose context. Inline actions and contextual menus keep the user in flow.

### When to Apply

- Any action the user might take while viewing a list or detail
- CRUD operations on entities visible in the current view
- Quick actions that don't require a full form

### Design Guidelines

- **Inline over page-level**: Prefer inline actions (buttons, dropdowns, popovers) over navigating to a dedicated page.
- **Contextual creation**: Allow creating related entities from where they are needed, not just from a central management page.
- **Progressive disclosure**: Start with a simple inline action; expand to a form/modal only if the action requires complex input.

### Codebase Examples

- **Worktree creation from breadcrumb (#402)**: Users can create worktrees directly from the session breadcrumb, without navigating to a worktree management page.
- **Review Queue (#405)**: Review actions are available in the dedicated queue view, not requiring visits to individual worktree pages.

---

## Principle 5: Glanceable Status, Opt-in Detail

### Statement

Dashboards and lists show summarized state at a glance. Detailed investigation (terminal output, full diffs) is opt-in via click. The user should understand overall state without reading raw output.

### Rationale

The orchestrator user manages many parallel workstreams. Reading raw terminal output for each agent to understand status is not scalable. The UI must distill state into scannable summaries, with full detail available on demand.

### When to Apply

- Session lists and dashboards
- Agent status displays
- Any view showing multiple items with underlying detail

### Design Guidelines

- **Summarize, don't truncate**: A good summary is not the first N characters of output. It is a semantic distillation: "Agent completed PR #42" is better than "✓ git push origin feat/..."
- **Visual hierarchy**: Use size, color, and position to communicate importance. The most critical information should be the most visually prominent.
- **Two-level pattern**: Level 1 is the summary visible in lists. Level 2 is the detail visible on click/expand. Design both levels intentionally.
- **No information hiding**: Glanceable does not mean hiding information. All data should be accessible — just not all at once.

### Codebase Examples

- **Session sidebar**: Shows session name, agent state (icon + color), and memo preview without showing full terminal output
- **Memo system**: Agents write structured summaries; raw terminal output is available separately in the terminal view

---

## Applying These Principles

### For Feature Design

When designing a new feature, evaluate it against each principle:

1. Does this feature force hub-and-spoke navigation? Can it be sequential?
2. Does this feature require active monitoring, or does it surface changes passively?
3. Does this feature treat all events equally, or does it respect urgency levels?
4. Are actions available where the user is, or do they require navigation?
5. Can the user understand state at a glance, or must they dig into detail?

### For Acceptance Criteria

When writing acceptance criteria for user-facing features, include UX principle verification:

- "User can process review items sequentially without returning to the list" (Principle 1)
- "Agent state change is visible from the session list without opening the session" (Principle 2)
- "Blocker notification is visually distinct from completion notification" (Principle 3)
- "Action X is available inline without page navigation" (Principle 4)
- "Status is understandable from the list view without expanding details" (Principle 5)

### For Code Review

UX architecture reviewers should verify that implementations follow these principles. A feature that works correctly but violates these principles creates a poor user experience at scale (many agents, many sessions, many concurrent tasks).
