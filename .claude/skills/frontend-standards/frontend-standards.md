# Frontend Standards

This document defines frontend-specific knowledge and patterns for the agent-console project.

## Tech Stack

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **TanStack Router** - File-based routing with type safety
- **TanStack Query** - Server state management
- **Tailwind CSS** - Utility-first styling
- **xterm.js** - Terminal emulator
- **Valibot** - Schema validation

## Directory Structure

```
packages/client/src/
├── components/     # React components
├── hooks/          # Custom React hooks
├── lib/            # Utilities and API clients
├── routes/         # TanStack Router file-based routes
├── schemas/        # Valibot validation schemas
└── test/           # Test utilities and setup
```

## React Patterns (Critical)

### Avoid useEffect - Use Alternatives

**useEffect should be a last resort.** Most use cases have better alternatives:

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

### useSyncExternalStore for External State

When subscribing to external state (global stores, singletons), use `useSyncExternalStore`:

```typescript
// lib/app-websocket.ts - External store with subscribe/getState pattern
export function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function getState(): AppWebSocketState {
  return state;
}

// hooks/useAppWs.ts - Hook using useSyncExternalStore
export function useAppWsState<T>(selector: (state: AppWebSocketState) => T): T {
  return useSyncExternalStore(subscribeState, () => selector(getState()));
}
```

**Why this pattern:**
- React-safe synchronization with external state
- Automatic subscription cleanup
- Works with concurrent rendering
- No stale closure issues

### Suspense for Async Operations

**Prefer Suspense** for handling loading states:

```typescript
// Route-level Suspense with TanStack Router
export const Route = createFileRoute('/sessions/$sessionId')({
  pendingComponent: () => <LoadingSpinner />,
  errorComponent: ({ error }) => <ErrorDisplay error={error} />,
})

// Component-level Suspense
<Suspense fallback={<Skeleton />}>
  <AsyncComponent />
</Suspense>
```

**Benefits:**
- Cleaner component code (no loading state management)
- Better UX with coordinated loading states
- Enables streaming and progressive rendering

### Component Design

- Prefer function components with hooks
- Keep components focused on single responsibility
- Extract complex logic into custom hooks
- Use composition over inheritance

### State Management Hierarchy

1. **Server state**: TanStack Query (`useQuery`, `useMutation`)
2. **External state**: `useSyncExternalStore`
3. **Local UI state**: `useState`, `useReducer`
4. **Shared client state**: React Context (sparingly)

Avoid prop drilling; prefer composition or context.

## TanStack Router

### File-Based Routing

- Routes are defined in `src/routes/` directory
- `__root.tsx` - Root layout
- `index.tsx` - Home route (`/`)
- `$param.tsx` - Dynamic segments

### Route Types

```typescript
// Route params are automatically typed
const { sessionId } = Route.useParams()

// Search params with validation
const { tab } = Route.useSearch()
```

### Navigation

```typescript
// Use Link component for navigation
<Link to="/sessions/$sessionId" params={{ sessionId }}>

// Programmatic navigation
const navigate = useNavigate()
navigate({ to: '/sessions/$sessionId', params: { sessionId } })
```

## TanStack Query

### Query Keys

Use consistent key factories for related queries:

```typescript
const sessionKeys = {
  all: ['sessions'] as const,
  detail: (id: string) => ['sessions', id] as const,
}
```

### Mutations

Always invalidate related queries after mutations:

```typescript
const mutation = useMutation({
  mutationFn: createSession,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: sessionKeys.all })
  },
})
```

## WebSocket Integration

### Choose the Right Pattern

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

## xterm.js Integration

### Terminal Setup

- Initialize with appropriate options (font, theme, scrollback)
- Attach fit addon for responsive sizing
- Handle resize events

### Input/Output

- Send user input via WebSocket
- Write received output to terminal
- Handle special keys appropriately

## Styling with Tailwind CSS

### Class Organization

Group related utilities: layout → spacing → sizing → colors → typography

### Responsive Design

Mobile-first approach (`sm:`, `md:`, `lg:` breakpoints)

## Form Handling with Valibot

### Validation Patterns

**Always add minLength before regex:**

```typescript
const schema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Field is required'),
  v.regex(pattern, errorMessage)
)
```

## Testing

### Component Testing

- Use `@testing-library/react`
- Test user interactions, not implementation
- Mock API calls appropriately

### Hook Testing

- Test all state transitions
- Mock dependencies appropriately

## Performance

- Memoize expensive computations with `useMemo`
- Use `useCallback` only when passing to optimized children
- Avoid inline object/array literals in JSX props

## Error Handling

### Error Boundaries

- Wrap major sections in error boundaries
- Provide meaningful fallback UI

### API Errors

- Display user-friendly error messages
- Provide retry mechanisms where appropriate
