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
1. **Used by single domain only** → Put in that domain directory
2. **Used by 2+ domains** → Put in `hooks/`
3. **Domain-agnostic utility** → Put in `hooks/`

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

## React Best Practices

### Suspense Usage

- Prefer Suspense for async operations and loading states over manual `isLoading` flags
- Use Suspense boundaries for code splitting and data fetching
- Pair ErrorBoundary with Suspense for error handling

```typescript
// ❌ Avoid: manual loading state
function UserProfile({ userId }: { userId: string }) {
  const { data, isLoading, error } = useQuery(...);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorMessage />;
  return <Profile user={data} />;
}

// ✅ Prefer: Suspense boundary
function UserProfile({ userId }: { userId: string }) {
  const { data } = useSuspenseQuery(...);
  return <Profile user={data} />;
}
// Wrapped with <Suspense fallback={<Spinner />}> at parent level
```

### useEffect Discipline

Challenge every useEffect - could it be:
- A derived value (computed from props/state)?
- An event handler?
- `useMemo` or `useCallback`?

```typescript
// ❌ Avoid: useEffect for derived state
const [fullName, setFullName] = useState('');
useEffect(() => {
  setFullName(`${firstName} ${lastName}`);
}, [firstName, lastName]);

// ✅ Prefer: derived value
const fullName = `${firstName} ${lastName}`;

// ❌ Avoid: useEffect for event response
useEffect(() => {
  if (submitted) {
    navigate('/success');
  }
}, [submitted]);

// ✅ Prefer: event handler
const handleSubmit = async () => {
  await submitForm();
  navigate('/success');
};
```

### Icon Components

SVG icons should be in a dedicated `Icons.tsx` file, not inline in View components:

```typescript
// ❌ Avoid: inline SVG in component
function DeleteButton() {
  return (
    <button>
      <svg viewBox="0 0 24 24">...</svg>
    </button>
  );
}

// ✅ Prefer: extracted icon component
// In Icons.tsx
export function TrashIcon(props: IconProps) {
  return <svg viewBox="0 0 24 24" {...props}>...</svg>;
}

// In component
function DeleteButton() {
  return (
    <button>
      <TrashIcon className="w-4 h-4" />
    </button>
  );
}
```

### External State (useSyncExternalStore)

Use `useSyncExternalStore` for singleton/global state subscriptions, not useEffect:

```typescript
// ❌ Avoid: useEffect with manual subscription
function useConnectionStatus() {
  const [status, setStatus] = useState(connectionStore.getStatus());
  useEffect(() => {
    const unsubscribe = connectionStore.subscribe(setStatus);
    return unsubscribe;
  }, []);
  return status;
}

// ✅ Prefer: useSyncExternalStore
function useConnectionStatus() {
  return useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getStatus,
    connectionStore.getServerStatus // optional: for SSR
  );
}
```

### Query Key Management

TanStack Query keys should use consistent factories:

```typescript
// Define key factories
const sessionKeys = {
  all: ['sessions'] as const,
  lists: () => [...sessionKeys.all, 'list'] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
};

// Use in queries
useQuery({ queryKey: sessionKeys.detail(sessionId), ... });

// Invalidation should be complete
queryClient.invalidateQueries({ queryKey: sessionKeys.all });
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
