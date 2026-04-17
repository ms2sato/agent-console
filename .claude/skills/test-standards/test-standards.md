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
