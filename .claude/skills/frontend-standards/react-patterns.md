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

## Async/Await and Fire-and-Forget

**Always use async/await. Avoid fire-and-forget patterns.**

Fire-and-forget (calling an async function without awaiting) causes:
- Silent errors that are difficult to debug
- Race conditions and unpredictable behavior
- Unhandled promise rejections

### Event Handlers

```typescript
// ❌ Fire-and-forget - errors are silently swallowed
const handleClick = () => {
  submitForm(data);  // Promise ignored
};

// ❌ async without await - same problem
const handleClick = async () => {
  submitForm(data);  // Still fire-and-forget
};

// ✅ Proper async/await with error handling
const handleClick = async () => {
  try {
    await submitForm(data);
  } catch (error) {
    showErrorToast(error);
  }
};
```

### useEffect with Async Operations

```typescript
// ❌ Fire-and-forget in useEffect
useEffect(() => {
  fetchData();  // Promise ignored, no cleanup
}, []);

// ❌ async useEffect (not allowed by React)
useEffect(async () => {  // TypeScript error
  await fetchData();
}, []);

// ✅ Proper pattern with cleanup
useEffect(() => {
  let cancelled = false;

  const load = async () => {
    try {
      const result = await fetchData();
      if (!cancelled) {
        setData(result);
      }
    } catch (error) {
      if (!cancelled) {
        setError(error);
      }
    }
  };

  load();

  return () => {
    cancelled = true;
  };
}, []);
```

### Intentional Background Work

When you genuinely need fire-and-forget (rare), make it explicit:

```typescript
// ✅ Explicit fire-and-forget with error handling
const handleClick = () => {
  // Intentionally not awaiting - fire-and-forget for analytics
  trackAnalytics('button_clicked').catch((error) => {
    console.error('Analytics failed:', error);
  });

  // Main action is still properly awaited
  await performMainAction();
};
```

**Note:** For data fetching, prefer TanStack Query over manual useEffect patterns.

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
