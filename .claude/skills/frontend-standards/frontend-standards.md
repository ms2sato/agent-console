# Frontend Standards (agent-console-specific)

> See [rules/frontend.md](../../rules/frontend.md) for the declarative rules (directory structure, hook placement, naming, useEffect alternatives, state management hierarchy, WebSocket patterns). This document covers agent-console-specific patterns. For generic React patterns (useSyncExternalStore, Suspense, useEffect cleanup, etc.), see [react-patterns.md](react-patterns.md).

## Tech Stack

- **React 18** — UI framework
- **Vite** — build tool and dev server
- **TanStack Router** — file-based routing with type safety
- **TanStack Query** — server state management
- **Tailwind CSS** — utility-first styling
- **xterm.js** — terminal emulator
- **Valibot** — schema validation

## TanStack Router

### File-Based Routing

Routes live in `src/routes/`. Conventions:
- `__root.tsx` — root layout
- `index.tsx` — home route (`/`)
- `$param.tsx` — dynamic segments

### Route Types and Navigation

```typescript
// Route params are automatically typed
const { sessionId } = Route.useParams()

// Search params with validation
const { tab } = Route.useSearch()

// Link component for navigation
<Link to="/sessions/$sessionId" params={{ sessionId }}>

// Programmatic navigation
const navigate = useNavigate()
navigate({ to: '/sessions/$sessionId', params: { sessionId } })
```

## TanStack Query

### Query Key Factories

Use consistent key factories for related queries:

```typescript
const sessionKeys = {
  all: ['sessions'] as const,
  detail: (id: string) => ['sessions', id] as const,
}
```

### Mutations with Invalidation

Always invalidate related queries after mutations:

```typescript
const mutation = useMutation({
  mutationFn: createSession,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: sessionKeys.all })
  },
})
```

## xterm.js Integration

- Initialize with appropriate options (font, theme, scrollback)
- Attach fit addon for responsive sizing
- Handle resize events
- Send user input via WebSocket
- Write received output to terminal
- Handle special keys appropriately

xterm.js is one of the narrow cases where `useEffect` is acceptable — the terminal instance's lifecycle is tied to the component.

## Tailwind CSS

- **Class organization**: layout → spacing → sizing → colors → typography
- **Responsive design**: mobile-first (`sm:`, `md:`, `lg:` breakpoints)

## Valibot Form Validation

**Always place `minLength` before `regex`:**

```typescript
const schema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1, 'Field is required'),
  v.regex(pattern, errorMessage)
)
```

Reason: without `minLength(1)`, the `regex` check on an empty string produces the regex error message ("Invalid format") instead of the more helpful "required" message. User-facing message quality depends on the order.

## Testing

- Use `@testing-library/react`
- Test user interactions, not implementation
- Mock API calls at the fetch level — see [test-standards skill](../test-standards/SKILL.md)

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

## Browser Verification for UI Changes

**Mandatory** for PRs that change UI components, layout, or styling. When a PR modifies visual elements, verify the actual rendered result using Chrome DevTools MCP before reporting acceptance.

### Procedure

1. Find free ports: `lsof -i :<port>` to check availability
2. Start the dev server from the PR's worktree:
   ```bash
   CLIENT_PORT=<free> PORT=<free> bun run dev
   ```
3. Navigate Chrome to the frontend URL (the `CLIENT_PORT`, not the backend `PORT`)
4. Take screenshots at both viewport sizes:
   - **PC**: 1200x700
   - **Mobile**: 375x667
5. Evaluate the UI yourself — do not just confirm "it renders". Check:
   - Layout and spacing
   - Information hierarchy (is the most important action prominent?)
   - Redundancy (duplicate labels, unnecessary descriptions)
   - Responsiveness (does mobile fallback work?)
   - Accessibility (buttons reachable, text readable)
6. Stop the dev server after verification

### What to Check

- Component layout changes
- Styling / Tailwind class changes
- New UI elements or dialogs
- Responsive behavior
- Form interactions (tab through fields, submit button reachable)
