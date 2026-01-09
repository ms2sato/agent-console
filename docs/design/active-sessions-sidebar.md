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
