# React Patterns (generic, code-example detail)

> See [rules/frontend.md](../../rules/frontend.md) for the declarative rules (useEffect alternatives table, state management hierarchy, async/await requirement). This file covers generic React patterns with the full code-example detail those rules imply. For agent-console-specific frontend standards (TanStack stack, xterm.js, Browser QA), see [frontend-standards.md](frontend-standards.md).

## useSyncExternalStore for External State

When subscribing to external state (global stores, singletons), use `useSyncExternalStore`:

```typescript
// lib/app-websocket.ts — external store with subscribe/getState
export function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function getState(): AppWebSocketState {
  return state;
}

// hooks/useAppWs.ts — hook using useSyncExternalStore
export function useAppWsState<T>(selector: (state: AppWebSocketState) => T): T {
  return useSyncExternalStore(subscribeState, () => selector(getState()));
}
```

Why this pattern:
- React-safe synchronization with external state
- Automatic subscription cleanup
- Works with concurrent rendering
- No stale-closure issues

Contrast with the useEffect-based approach the rule tells you to avoid:

```typescript
// ❌ useEffect with manual subscription — stale closures, cleanup bugs
function useConnectionStatus() {
  const [status, setStatus] = useState(connectionStore.getStatus());
  useEffect(() => {
    const unsubscribe = connectionStore.subscribe(setStatus);
    return unsubscribe;
  }, []);
  return status;
}

// ✅ useSyncExternalStore
function useConnectionStatus() {
  return useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getStatus,
    connectionStore.getServerStatus  // optional: for SSR
  );
}
```

## Suspense for Async Operations

**Prefer Suspense** over manual `isLoading` flags:

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

Benefits:
- Cleaner component code (no loading-state management)
- Coordinated loading states at a boundary
- Enables streaming and progressive rendering

```typescript
// ❌ Manual loading state
function UserProfile({ userId }: { userId: string }) {
  const { data, isLoading, error } = useQuery(...);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorMessage />;
  return <Profile user={data} />;
}

// ✅ Suspense boundary
function UserProfile({ userId }: { userId: string }) {
  const { data } = useSuspenseQuery(...);
  return <Profile user={data} />;
}
// Wrapped with <Suspense fallback={<Spinner />}> at parent level
```

## Async/Await in Event Handlers

The rule bans fire-and-forget. This is the mechanical pattern:

```typescript
// ❌ Fire-and-forget — errors are silently swallowed
const handleClick = () => {
  submitForm(data);  // Promise ignored
};

// ❌ async without await — same problem
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

## Async useEffect with Cleanup

useEffect callbacks cannot be async directly. The canonical pattern:

```typescript
// ❌ Fire-and-forget in useEffect
useEffect(() => {
  fetchData();  // Promise ignored, no cleanup
}, []);

// ❌ async useEffect (not allowed by React)
useEffect(async () => {  // TypeScript error
  await fetchData();
}, []);

// ✅ Proper pattern with cleanup flag
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

The `cancelled` flag prevents state updates on an unmounted component (React will warn, and stale state can overwrite fresh state in the common remount-then-settle case).

## Intentional Background Work

When you genuinely need fire-and-forget (rare), make it explicit:

```typescript
// ✅ Explicit fire-and-forget with local error handling
const handleClick = async () => {
  // Intentionally not awaiting — fire-and-forget for analytics
  trackAnalytics('button_clicked').catch((error) => {
    console.error('Analytics failed:', error);
  });

  // Main action is still properly awaited
  await performMainAction();
};
```

The `.catch()` is what makes this safe. A bare `trackAnalytics(...)` with no `.catch()` would silently swallow an unhandled rejection.

**Prefer TanStack Query** over manual data-fetch useEffects. Query handles the cleanup, cancellation, caching, and retries for you. Manual useEffect is only appropriate for non-request-shaped async work (subscriptions, timers, third-party library integration).

## Component Design

- Prefer function components with hooks
- Keep components focused on a single responsibility
- Extract complex logic into custom hooks
- Use composition over inheritance

Avoid prop drilling; prefer composition or context.

## Icon Components

SVG icons belong in a dedicated `Icons.tsx` file, not inline in view components:

```typescript
// ❌ Inline SVG in component
function DeleteButton() {
  return (
    <button>
      <svg viewBox="0 0 24 24">...</svg>
    </button>
  );
}

// ✅ Extracted icon component
// In Icons.tsx
export function TrashIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" {...props}>...</svg>;
}

// In the button
function DeleteButton() {
  return (
    <button>
      <TrashIcon className="w-4 h-4" />
    </button>
  );
}
```

Benefits: markup stays readable, icons are reusable, and accessibility attributes are set in one place.
