---
paths:
  - "packages/client/**"
---

# Frontend Rules

## Tech Stack

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **TanStack Router** - File-based routing with type safety
- **TanStack Query** - Server state management
- **Tailwind CSS** - Utility-first styling
- **xterm.js** - Terminal emulator
- **Valibot** - Schema validation

## Directory Structure and Naming

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

### Directory Organization Strategy

**Components use domain-based organization:**
- Group related components into domain directories (`sessions/`, `workers/`, `agents/`)
- Shared UI components go in `ui/`
- Standalone components can remain flat

**Hooks use hybrid approach:**

| Hook Type | Location | Example |
|-----------|----------|---------|
| Domain-specific | Inside domain directory | `components/sessions/useSessionState.ts` |
| Multi-domain | `hooks/` | `hooks/useTerminalWebSocket.ts` |
| Generic utility | `hooks/` | `hooks/useMounted.ts` |

Decision criteria:
1. **Used by single domain only** -> Put in that domain directory
2. **Used by 2+ domains** -> Put in `hooks/`
3. **Domain-agnostic utility** -> Put in `hooks/`

### File Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| React component | PascalCase | `SessionList.tsx`, `WorkerTabs.tsx` |
| Custom hook | camelCase + `use` prefix | `useTerminal.ts`, `useAppConnection.ts` |
| Utility/helper | kebab-case | `api-client.ts`, `format-date.ts` |
| Type definition | kebab-case | `types.ts`, `session-types.ts` |
| Schema | kebab-case | `session-schema.ts` |
| Test | original + `.test` | `SessionList.test.tsx`, `useTerminal.test.ts` |

### Directory Naming

- Use **kebab-case** for all directories
- Domain directories use plural nouns: `sessions/`, `workers/`, `agents/`

### Export Conventions

- Component file name = component name: `SessionList.tsx` exports `SessionList`
- For component directories, use `index.ts` to re-export the main component

## Key React Principles

- **Avoid useEffect** - Use TanStack Query, useSyncExternalStore, or event handlers instead
- **Prefer Suspense** - For loading states and async boundaries
- **useSyncExternalStore** - For external state subscriptions (WebSocket, global stores)
- **Server is the source of truth** - Don't maintain conflicting client state

### useEffect Alternatives

| Instead of useEffect for... | Use this |
|----------------------------|----------|
| Fetching data | TanStack Query (`useQuery`) |
| Subscribing to external store | `useSyncExternalStore` |
| Derived state | Compute during render or `useMemo` |
| Responding to user events | Event handlers |
| Syncing with parent component | Lift state up or use context |

**When useEffect is acceptable:**
- Component-scoped WebSocket connections (tied to component lifecycle)
- Third-party library integration (xterm.js, etc.)
- Browser API subscriptions (resize observers, etc.)

### State Management Hierarchy

1. **Server state**: TanStack Query (`useQuery`, `useMutation`)
2. **External state**: `useSyncExternalStore`
3. **Local UI state**: `useState`, `useReducer`
4. **Shared client state**: React Context (sparingly)

Avoid prop drilling; prefer composition or context.

### Component Design

- Prefer function components with hooks
- Keep components focused on single responsibility
- Extract complex logic into custom hooks
- Use composition over inheritance

### Icon Components

SVG icons belong in a dedicated `Icons.tsx` file, not inline in View components.

### Async/Await

**Always use async/await. Avoid fire-and-forget patterns.** Fire-and-forget (calling an async function without awaiting) causes silent errors, race conditions, and unhandled promise rejections.

## TanStack Router

- Routes are defined in `src/routes/` directory
- `__root.tsx` - Root layout, `index.tsx` - Home route, `$param.tsx` - Dynamic segments
- Route params and search params are automatically typed

## TanStack Query

- Use consistent key factories for related queries
- Always invalidate related queries after mutations

## WebSocket Integration

**Singleton pattern** - For app-wide connections that persist across navigation:
- Example: `/ws/app` for session/worker lifecycle events
- Use module-level state with `useSyncExternalStore`

**Hook-based pattern** - For component-scoped connections:
- Example: `/ws/session/:id/worker/:id` for terminal I/O
- Use `useEffect` with cleanup, tied to component lifecycle

### State Synchronization

- Server is the source of truth
- Update UI based on server messages
- Don't maintain conflicting client state

## Styling with Tailwind CSS

- Group related utilities: layout -> spacing -> sizing -> colors -> typography
- Mobile-first approach (`sm:`, `md:`, `lg:` breakpoints)

## Form Handling with Valibot

**Always add minLength before regex:**

```typescript
const schema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Field is required'),
  v.regex(pattern, errorMessage)
)
```

## Performance

- Memoize expensive computations with `useMemo`
- Use `useCallback` only when passing to optimized children
- Avoid inline object/array literals in JSX props

## Error Handling

- Wrap major sections in error boundaries
- Provide meaningful fallback UI
- Display user-friendly error messages with retry mechanisms

See also: `ux-design-standards` skill for UX design principles that guide feature-level decisions.
