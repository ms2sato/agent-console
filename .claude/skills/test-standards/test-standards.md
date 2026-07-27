# Test Standards (Procedural Detail)

> See [rules/testing.md](../../rules/testing.md) for the declarative rules (core principles, anti-patterns, evaluation criteria, naming conventions, pre-implementation checklist, unit-vs-integration responsibilities). This document covers procedural detail and code patterns.

## Tests Must Test Production Code — Worked Example

```typescript
// ❌ Wrong: duplicating logic in the test file
function cleanupOrphanProcesses(deps: MockDeps) {
  // Re-implementing production logic...
}

// ✅ Correct: import and test production code
import { SessionManager } from '../session-manager';

describe('SessionManager', () => {
  it('should cleanup orphan processes', () => {
    const manager = new SessionManager();
    // Test actual production code
  });
});
```

## Mock at the Lowest Level — Fetch-Level Pattern

```typescript
// ❌ Avoid: module-level mocking
mock.module('../lib/api', () => ({
  deleteWorktree: mock(() => Promise.resolve()),
}));
// Problems: bypasses actual API logic, permanent in bun:test

// ✅ Correct: mock at fetch level
const originalFetch = globalThis.fetch;
globalThis.fetch = mock(() => Promise.resolve(new Response()));

afterAll(() => {
  globalThis.fetch = originalFetch;
});
// Benefits: tests URL construction, error handling, etc.
```

## Dependency Injection Over Module Mocking

The rule names this as Anti-Pattern #2. The mechanical reason: in bun:test, `mock.module()` is **process-global and permanent**. A single call pollutes every test file that runs in the same process. Past incidents:

- Mocking `config.js` in deletion tests broke 26+ unrelated tests.
- Centralizing a `worktreeService` mock into a shared helper broke 23 MCP tests via import-time side effects.

**Common traps that do NOT solve the problem:**

- "Each test file defines its own `mock.module()`" — still leaks if Bun runs files in the same process.
- "Centralized mock helper that calls `mock.module()` once" — makes it worse: every file that imports the helper triggers the global mock via import-time side effects.
- "Reset mocks in `beforeEach`" — `mock.module()` cannot be reset in Bun.

**Correct fix: refactor the production code for DI.** When a service depends on other services or configuration, accept them as parameters (constructor or function args) rather than importing a singleton.

```typescript
// ❌ mock.module — pollutes other tests, cannot be reset
mock.module('../../services/worktree-service.js', () => ({
  worktreeService: { listWorktrees: mock(() => []) },
}));

// ✅ DI via AppContext — isolated, no global side effects
app.use('*', async (c, next) => {
  c.set('appContext', asAppContext({
    worktreeService: mockWorktreeService,  // injected mock
  }));
  await next();
});

// ✅ DI via function parameters — for service-to-service deps
export async function deleteWorktree(
  params: DeleteWorktreeParams,
  deps: DeleteWorktreeDeps,  // worktreeService, sessionManager, etc.
): Promise<DeleteWorktreeResult> { ... }

// In tests: pass mock deps directly
const result = await deleteWorktree(params, { worktreeService: mockService, ... });
```

Route handler tests in this repository use `createTestContext()` or `asAppContext()` to inject mocks without `mock.module()`.

## Form Component Testing

Forms using React Hook Form + Valibot need component-level tests beyond schema unit tests.

### Test Conditional Fields When Hidden

```typescript
// customBranch is hidden in prompt mode
it('should submit in prompt mode without customBranch', async () => {
  await user.type(promptInput, 'Some prompt');
  await user.click(submitButton);
  expect(onSubmit).toHaveBeenCalled();
});
```

### Test Empty Default Values

```typescript
it('should show validation error when submitting with empty default', async () => {
  await user.click(submitButton);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByText(/required/)).toBeTruthy();
});
```

### Verify Error Message Content (not just existence)

```typescript
// ❌ Insufficient: only checks error existence
expect(screen.getByRole('alert')).toBeTruthy();

// ✅ Correct: verifies the message text
expect(screen.getByText('Branch name is required')).toBeTruthy();
```

### Explicitly Test "Cannot Submit" Cases

```typescript
it('should NOT call onSubmit when validation fails', async () => {
  await user.click(submitButton);
  expect(onSubmit).not.toHaveBeenCalled();
});
```

## Client-Server Boundary Testing — Server Bridge Pattern

The bug this pattern catches:

```typescript
// Bug: undefined is omitted in JSON
activityPatterns: askingPatterns ? { askingPatterns } : undefined
// JSON.stringify({ activityPatterns: undefined }) → "{}"
// Server receives nothing, keeps old value instead of clearing
```

Unit tests on either client or server alone cannot catch this — the bug lives in the serialization boundary.

### Pattern

```typescript
describe('Client-Server Boundary', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let capturedRequests: Array<{ url: string; method: string; body: any }>;

  beforeEach(async () => {
    app = await createApp();
    capturedRequests = [];

    // Bridge: capture request AND forward to server
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(options.body as string) : undefined;
      capturedRequests.push({ url: url as string, method: options?.method || 'GET', body });
      return app.request(url as string, { method: options?.method, headers: options?.headers, body: options?.body });
    };
  });

  it('should send null to clear field', async () => {
    // 1. Render form and interact
    // 2. Verify client sent null (not undefined)
    expect(capturedRequests.at(-1)?.body.field).toBeNull();
    // 3. Verify server processed correctly
  });
});
```

This gives you a single test file that exercises the full round-trip: user event → form serialization → HTTP body → server handler → persisted state. If any step drops or mistransforms data, the test fails.

## Converting Cross-File `mock.module()` Poisoning

See [rules/testing.md](../../rules/testing.md) Anti-Pattern #2 for the prohibition (never `mock.module()` a target another test file real-imports) and when the exception applies. This section is the conversion how-to, with three worked patterns in order of preference. Before converting, grep the repo for other real importers of the target module to confirm the poisoning classification (Issue #977 Phase 1).

### Pattern 1 — DI seam (prop / injected factory)

Best when the component itself resolves the dependency via a module-level singleton call. Add an optional prop defaulting to the real function; production and other consumers are unaffected because the prop is optional.

```typescript
// Production: TerminalAdapter.tsx
export function TerminalAdapter({
  // ...
  createInstance = getOrCreateTerminal,   // optional DI seam, defaults to the real store
}: TerminalProps & { createInstance?: typeof getOrCreateTerminal }) {
  const instance = useMemo(() => createInstance(sessionId, workerId, opts), [createInstance, sessionId, workerId, opts]);
  // ...
}

// Test: TerminalAdapter.test.tsx
const mockGetOrCreateTerminal = mock((_sessionId: string, _workerId: string): TerminalInstance => stubInstance);
render(<TerminalAdapter sessionId="s" workerId="w" createInstance={mockGetOrCreateTerminal} />);
```

(Worked example: PR #976, `packages/client/src/components/terminal/TerminalAdapter.tsx` + its test.)

### Pattern 2 — `spyOn()` on a named export

Best for a hook or function the component-under-test imports and calls directly, when adding a DI prop is not warranted. `spyOn` is restorable per-test (unlike `mock.module()`), so it must be paired with `.mockRestore()` in `afterEach` — without that, the spy leaks into the next test in the same file (not other files, since `spyOn` targets a specific module-namespace object each test file imports independently).

```typescript
import * as useAppWsModule from '../../hooks/useAppWs';

let useAppWsEventSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  useAppWsEventSpy = spyOn(useAppWsModule, 'useAppWsEvent').mockImplementation(() => undefined);
});

afterEach(() => {
  useAppWsEventSpy.mockRestore();
});
```

A generic function (`useAppWsState<T>(selector: (state) => T): T`) needs an explicit generic on the mock implementation so the cast is not silently `any`:

```typescript
useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(<T,>() => false as T);
```

(Worked examples: `routes/__tests__/index.test.tsx`, `__tests__/routes/agents/index.test.tsx`, `components/sessions/hooks/__tests__/useSessionPageState.test.ts`, `components/worktrees/__tests__/QuickWorktreeDialog.test.tsx`.)

### Pattern 3 — Real module/context + injected fake value

Best when the module already exposes a designed seam — a context Provider, or a setter function — instead of hard-coding a return value via `mock.module()`. This is the least invasive option: zero production code changes, and the "fake" data flows through the real module's real code path.

```typescript
// lib/capabilities.ts already exposes a real setter for its module-level cache:
import { setCapabilities } from '../../lib/capabilities';

beforeEach(() => {
  setCapabilities({ vscode: false, vscodeOpenMode: 'local-spawn', vscodeRemoteHost: null });
});
```

```typescript
// A React context consumed via useContext(): provide a REAL Provider with a fake value
// instead of mock.module()-replacing the hook that reads it.
import { WorktreeDeletionTasksContext } from '../../contexts/root-contexts';

render(
  <WorktreeDeletionTasksContext.Provider value={mockDeletionTasks}>
    <SessionSettings {...props} />
  </WorktreeDeletionTasksContext.Provider>
);
```

Note the context is imported from its owning module (`contexts/root-contexts.ts`), not from the barrel that re-exports it (`routes/__root.tsx`) — importing from the owning module avoids pulling in the barrel's heavier dependency surface (router registration, layout components) and is the same object reference, so `useContext` inside the real hook resolves correctly either way.

(Worked examples: `__tests__/routes/WorktreeRow.test.tsx` (Pattern 3a, setter), `hooks/__tests__/useCreateWorktree.test.ts` and `components/__tests__/SessionSettings.test.tsx` (Pattern 3b, Provider).)

### Which pattern to reach for

1. Does the target module already expose a public setter or a context Provider for the exact state the test needs? → **Pattern 3**.
2. Is the dependency resolved via a direct function/hook call the component makes itself, with no existing seam? → **Pattern 2** (`spyOn`) is usually less code than adding a new prop; reach for **Pattern 1** (DI prop) only when the component needs the seam for a reason beyond testing (e.g. a legitimate caller-supplied override).
3. Never fall back to `mock.module()` to avoid picking one of the above — see rules/testing.md Anti-Pattern #2.

### `mock.module()` merges, it does not replace

When classifying whether a `mock.module()` call site is a cross-file poisoner (Issue #977 Phase 1), do not assume the factory's return value fully replaces the module's export namespace for other importers. Empirically (Bun 1.3.10), `mock.module(specifier, factory)` **merges** `factory()`'s return value onto the real module's exports — an export the factory does not declare falls through to the real implementation for *every* importer, not just the ones that ran before the mock. Only the properties the factory *does* declare are overridden, and that override is what leaks cross-file.

Two consequences for classification:

- **A partial-override factory does not "break" untouched exports.** `lib/capabilities`'s poisoner overrode `hasVSCode` / `getVSCodeOpenMode` / `getVSCodeRemoteHost` but not `setCapabilities` — a victim reading `setCapabilities` sees the real function regardless of poisoning order. Do not conclude "benign" from this: the *overridden* exports still leak (verified below).
- **"Does the victim's assertion still pass?" is not a reliable signal.** A victim can read a poisoned export, receive the wrong value, and still pass all its own assertions if it happens to be structurally tolerant of the substitution (e.g. it re-derives its own Provider/consumer pair from the same poisoned reference, so both sides stay internally consistent even though neither is talking to the real module). Classify by whether the *specific overridden export* is provably read by another file — via a reference/identity check or by inspecting the resolved function's source (`fn.toString()`) — not by whether that file's test suite currently goes red.

**Verification technique used to classify all 5 call sites in PR #977:** force deterministic load order across two real files (CLI-arg order is not respected by Bun's scheduler — see the load-order note below) by placing a lexicographically-earlier-sorting temp copy of the poisoner in `src/`, then read the victim's imported binding's `.toString()` (for functions) or compare `===` identity (for objects/contexts) against a value stashed on `globalThis` by the poisoner. A source string matching the poisoner's factory body, or an identity match against the poisoner's locally-created object, is unambiguous proof of the leak — independent of whether the victim's own assertions happen to still pass.

**Load order is not controllable via CLI argument order or simple filename convention.** Passing files in a specific order to `bun test fileA fileB` does not guarantee `fileA` loads first — Bun applies its own internal scan order regardless of argument order, and that order is not simple alphabetical (it appeared to depend on more than just the basename in ad-hoc testing). The only reliable lever found: bun evaluates a *directory tree* scan in some deterministic-but-opaque order, and paths starting with a double-underscore directory (`src/__polarity_X`) reliably sort ahead of ordinary `src/<lowercase-dir>/...` paths in practice — but always verify with an explicit `console.error` load marker in each candidate file rather than trusting the naming convention alone.

## Bun mock typing for `calls[N][M]` access

Bun's `mock(async () => {})` infers the mock's `args` type as `[]` when no parameters are declared, even when the call site passes arguments. Reading `mock.calls[0][1]` then fails type-checking with `TS2493: Tuple type '[]' of length '0' has no element at index '1'`.

Declare the parameter signature explicitly so the mock's `calls[N][M]` projection is correctly typed:

```typescript
// args inferred as [] — mock.calls[0][1] fails type-check
const fn = mock(async () => {});

// args typed as [ArgT, ArgU] — mock.calls[0][1] is ArgU | undefined
const fn = mock(async (_a: ArgT, _b: ArgU) => {});
```

This is a Bun typing quirk, not a behavioural bug — runtime captures arguments correctly either way. Use the explicit-signature form when assertions need indexed access into the captured arguments.

(Source: PR #770 round 3 — `mock(async () => {})` failed type-check on `mock.calls[N][M]` reads; explicit signature added in commit `8e2f644`.)
