# Active Sessions Sidebar Design

## Overview

A collapsible left sidebar that displays active sessions with their activity states, visible on both Dashboard and Session pages.

## Requirements

- **Collapsible**: Expand/collapse toggle with state persisted to localStorage
- **Scope**: Sessions with activity state (Waiting/Idle/Working) only
- **Priority order**: Waiting (asking) > Idle > Working (active)
- **Navigation**: Click session widget to navigate to that session
- **Visibility**: Both Dashboard and Session pages

## UI Design

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Header                                                      │
├────────┬────────────────────────────────────────────────────┤
│        │                                                    │
│ Side   │  Main Content                                      │
│ bar    │  (Dashboard or Session)                            │
│        │                                                    │
└────────┴────────────────────────────────────────────────────┘
```

### Sidebar States

**Expanded (224px / w-56)**:
```
┌──────────────────────┐
│ ◀ Active Sessions    │  <- Header with collapse button
├──────────────────────┤
│ 🔴 feat/login        │  <- Waiting (yellow, pulse)
│ 🟡 fix/bug-123       │  <- Idle (gray)
│ 🟢 refactor/api      │  <- Working (blue, subtle pulse)
└──────────────────────┘
```

**Collapsed (48px / w-12)**:
```
┌────┐
│ ▶  │  <- Expand button
├────┤
│ 🔴 │  <- Indicator only (tooltip on hover)
│ 🟡 │
│ 🟢 │
└────┘
```

### Session Item Content

Each session item displays:

**Worktree Session**:
```
┌────────────────────────────┐
│ 🔴 agent-console           │  <- Repository name (bold)
│    feat/active-sidebar     │  <- Branch name or session title
└────────────────────────────┘
```

**Quick Session**:
```
┌────────────────────────────┐
│ 🟢 Quick Session           │  <- "Quick Session" label
│    ~/projects/demo         │  <- Location path (truncated)
└────────────────────────────┘
```

**Display fields**:
1. **Activity indicator** - Colored dot with state
2. **Line 1 (primary)** - Repository name or "Quick Session"
3. **Line 2 (secondary)** - Branch name, session title, or path

**Collapsed tooltip**: "repository / branch" or "Quick Session: path"

### Activity Indicators

| State | Color | Animation | Meaning |
|-------|-------|-----------|---------|
| Waiting (`asking`) | Yellow (`text-yellow-400`) | Pulse | Needs user input |
| Idle (`idle`) | Gray (`text-gray-400`) | None | Ready, not working |
| Working (`active`) | Blue (`text-blue-400`) | Subtle pulse | Processing |

### Sort Priority

Sessions are sorted by activity state priority:

```typescript
const activityPriority: Record<AgentActivityState, number> = {
  'asking': 0,   // Highest - needs user attention
  'idle': 1,     // Medium
  'active': 2,   // Lowest - working autonomously
  'unknown': 3,  // Not shown in sidebar
};
```

### View modes (flat / tree)

The active list has two view modes, a toggle beside the filter buttons (`aria-pressed`, labels "Flat" and "Tree"). The mode is persisted under `session-view-mode` (the `useSessionFilter` idiom, every localStorage access guarded); the default is **flat**, which is the list exactly as described above.

**Tree rule.** In tree mode the active list is built from `parentSessionId` by the pure `buildSessionTree` (`components/sidebar/session-tree.ts`): a session with no parent is a root; a session whose parent is in the list is indented under it, recursively to any depth; the roots keep the flat list's order (activity priority only) and each set of children is sorted by the same activity priority with title then id as tie-breakers (the activity-priority comparator is one exported function shared with the flat sort, not a copy; the title/id tie-breakers apply to children only); the tree is ONE ungrouped list: the repository grouping of the flat list is not applied in tree mode, because a child can live in another repository than its parent and grouping would split a tree and mislabel its children as orphans (only flat mode keeps the grouping; the collapsed icon column is flat and ungrouped); each node with children has a chevron that collapses and expands its subtree (the collapsed set is component state and is not persisted). Paused sessions stay in their own grouped list and creation/deletion task rows stay as they are: they are never part of the tree.

**Orphan rule.** A session whose `parentSessionId` names a session that is not in the rendered active list is shown at the root with a small badge that states WHY, never hidden. The builder only flags it (`orphan: true`); the component resolves the reason: "parent paused" when the parent id is in the paused list (paused sessions are not in the tree), "parent hidden" when the parent is in the unfiltered session list but not rendered (the badge title says "the parent session is not shown in this list (hidden by the filter, or it has no active worker)": the reason is deliberately loose and covers two sub-cases, a parent hidden by the Mine / Shared filter and a parent that is in the unfiltered list but has no active worker and so no activity state), and "parent gone" otherwise (deleted). A cycle (A's parent is B and B's parent is A; the server cannot produce one, the guard is cheap) makes both roots flagged as orphans, with no infinite loop.

**Collapsed sidebar.** The icon column has no room for an indent: in tree mode it renders the same flat icon column as flat mode.

Decision table (every cell is a decision; none is undecided):

| operation | desktop sidebar | mobile drawer | collapsed sidebar | dashboard (`routes/index.tsx` session list) | MCP (`list_sessions`) |
|---|---|---|---|---|---|
| switch view mode | do | do: the same component | not here: no room for indent, flat icons | not here: the dashboard groups by repository, the tree is a sidebar concern | not here: `list_sessions` already carries `parentSessionId`; the tree is a presentation |
| expand / collapse a subtree | do | do: the same component | not here: no room for indent, flat icons | not here: the dashboard groups by repository, the tree is a sidebar concern | not here: `list_sessions` already carries `parentSessionId`; the tree is a presentation |
| orphan display ("parent gone", "parent paused" or "parent hidden", with the reason in the title) | do | do: the same component | not here: no room for indent, flat icons | not here: the dashboard groups by repository, the tree is a sidebar concern | not here: `list_sessions` already carries `parentSessionId`; the tree is a presentation |
| child ordering (activity priority, then title or id) | do | do: the same component | not here: no room for indent, flat icons | not here: the dashboard groups by repository, the tree is a sidebar concern | not here: `list_sessions` already carries `parentSessionId`; the tree is a presentation |

## Implementation

### New Files

| File | Purpose |
|------|---------|
| `components/sidebar/ActiveSessionsSidebar.tsx` | Main sidebar component |
| `components/sidebar/ActivityIndicator.tsx` | Status dot with animation |
| `hooks/useSidebarState.ts` | Collapse state with localStorage persistence |
| `hooks/useActiveSessionsWithActivity.ts` | Sessions filtering and sorting |

### Modified Files

| File | Changes |
|------|---------|
| `routes/__root.tsx` | Add sidebar to layout |
| `routes/sessions/$sessionId.tsx` | Include sidebar in session layout |
| `components/Icons.tsx` | Add `ChevronLeftIcon` |

### Component Structure

```
ActiveSessionsSidebar
├── Header (title + toggle button)
└── SessionList
    └── SessionItem (for each session)
        ├── ActivityIndicator
        └── SessionTitle (with tooltip)
```

### Data Flow

```
WebSocket (/ws/app)
    │
    ▼
useAppWsEvent (existing)
    │
    ▼
useActiveSessionsWithActivity (new)
    │ - Filter: only sessions with activity != 'unknown'
    │ - Sort: by activity priority
    │ - Map: session + activity state
    ▼
ActiveSessionsSidebar
    │
    ▼
Click → navigate(`/sessions/${sessionId}`)
```

### State Persistence

```typescript
// Storage key
const SIDEBAR_COLLAPSED_KEY = 'agent-console:sidebar-collapsed';

// Hook implementation
export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return stored ? JSON.parse(stored) : false;
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
  }, [collapsed]);

  return { collapsed, setCollapsed, toggle: () => setCollapsed(prev => !prev) };
}
```

## Styling

Uses Tailwind CSS classes consistent with existing codebase:

- Background: `bg-slate-900`
- Border: `border-r border-slate-700`
- Text: `text-gray-300` (primary), `text-gray-500` (secondary)
- Transitions: `transition-all duration-200`
- Hover: `hover:bg-slate-800`

### Animation Classes

```css
/* Pulse animation for Waiting state */
@keyframes pulse-indicator {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.animate-pulse-indicator {
  animation: pulse-indicator 1.5s ease-in-out infinite;
}
```

## Interactions

1. **Collapse/Expand**: Click toggle button in header
2. **Navigate to Session**: Click session item
3. **Hover (collapsed)**: Show tooltip with session title
4. **Real-time Updates**: Activity changes reflected immediately via WebSocket

## Considerations

### Session Page Integration

On session pages, the sidebar shows alongside the terminal. This allows quick switching between sessions without returning to Dashboard.

### Empty State

When no sessions have activity states, show a subtle message:
- Expanded: "No active sessions"
- Collapsed: (empty, just the toggle button)

### Responsive Behavior

For very narrow screens, consider auto-collapsing the sidebar. Initial implementation can skip this and add later if needed.
