# React Patterns

This document defines React patterns to follow in the agent-console project.

## Avoid useEffect - Use Alternatives

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

## useSyncExternalStore for External State

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

## Suspense for Async Operations

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

## Component Design

- Prefer function components with hooks
- Keep components focused on single responsibility
- Extract complex logic into custom hooks
- Use composition over inheritance

## State Management Hierarchy

1. **Server state**: TanStack Query (`useQuery`, `useMutation`)
2. **External state**: `useSyncExternalStore`
3. **Local UI state**: `useState`, `useReducer`
4. **Shared client state**: React Context (sparingly)

Avoid prop drilling; prefer composition or context.
