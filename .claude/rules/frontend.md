---
paths:
  - "packages/client/**"
---

# Frontend Rules

**Delegate to `frontend-specialist` subagent** for implementation in this package. Primary agent should not write client code directly.

## Directory Structure

```
packages/client/src/
├── components/     # React components (domain-organized)
│   ├── sessions/   # Session-related components and hooks
│   ├── workers/    # Worker-related components and hooks
│   └── ui/         # Shared UI components
├── hooks/          # Shared/generic hooks only
├── lib/            # Utilities and API clients
├── routes/         # TanStack Router file-based routes
├── schemas/        # Valibot validation schemas
└── test/           # Test utilities and setup
```

## Hook Placement

| Hook Type | Location | Example |
|-----------|----------|---------|
| Used by single domain only | Inside domain directory | `components/sessions/hooks/useSessionPageState.ts` |
| Used by 2+ domains | `hooks/` | `hooks/useAppWs.ts` |
| Generic utility | `hooks/` | `hooks/useIsMobile.ts` |

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| React component | PascalCase `.tsx` | `SessionList.tsx` |
| Custom hook | camelCase `use` prefix `.ts` | `useTerminal.ts` |
| Utility/helper | kebab-case `.ts` | `api-client.ts` |
| Test | original + `.test` | `SessionList.test.tsx` |

- **kebab-case** for all directories. Domain directories use plural nouns: `sessions/`, `workers/`
- Component file name = component name. Use `index.ts` to re-export from directories.
- Use named exports; avoid default exports.

## Avoid useEffect

| Instead of useEffect for... | Use this |
|----------------------------|----------|
| Fetching data | TanStack Query (`useQuery`) |
| Subscribing to external store | `useSyncExternalStore` |
| Derived state | Compute during render or `useMemo` |
| Responding to user events | Event handlers |

**When useEffect is acceptable:** Component-scoped WebSocket connections, third-party library integration (xterm.js), browser API subscriptions (resize observers).

## State Management Hierarchy

1. **Server state**: TanStack Query (`useQuery`, `useMutation`)
2. **External state**: `useSyncExternalStore`
3. **Local UI state**: `useState`, `useReducer`
4. **Shared client state**: React Context (sparingly)

**Server is the source of truth** — don't maintain conflicting client state.

## WebSocket Integration

- **Singleton pattern** (app-wide, persists across navigation): module-level state with `useSyncExternalStore`
- **Hook-based pattern** (component-scoped): `useEffect` with cleanup, tied to component lifecycle

## Valibot Form Validation

**Always add minLength before regex:**

```typescript
const schema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Field is required'),
  v.regex(pattern, errorMessage)
)
```

## Async/Await

**Never use fire-and-forget patterns.** Always await async operations to avoid silent errors and race conditions.
