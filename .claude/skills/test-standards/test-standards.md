# Test Standards

This document defines testing best practices and anti-patterns for the agent-console project.

For additional details, see [docs/testing-guidelines.md](../../../docs/testing-guidelines.md).

## Core Principles

### 1. Tests Must Test Production Code

Import and test production code directly. Never duplicate production logic in test files.

```typescript
// ❌ Wrong: Duplicating logic in test file
function cleanupOrphanProcesses(deps: MockDeps) {
  // Re-implementing production logic...
}

// ✅ Correct: Import and test production code
import { SessionManager } from '../session-manager';

describe('SessionManager', () => {
  it('should cleanup orphan processes', () => {
    const manager = new SessionManager();
    // Test actual production code
  });
});
```

### 2. Test Through Public Interface

If you feel the need to test a private method, reconsider the design.

```typescript
// ❌ Wrong: Trying to access private method
// manager['privateMethod']() - Don't do this

// ✅ Correct: Test through public interface
describe('SessionManager', () => {
  it('should cleanup orphan processes on initialization', () => {
    // Test the observable behavior via public API
  });
});
```

### 3. Mock at the Lowest Level

Mock at the communication layer (`fetch`, `WebSocket`, file system) rather than mocking intermediate modules.

```typescript
// ❌ Avoid: Module-level mocking
mock.module('../lib/api', () => ({
  deleteWorktree: mock(() => Promise.resolve()),
}));
// Problems: bypasses actual API logic, permanent in bun:test

// ✅ Correct: Mock at fetch level
const originalFetch = globalThis.fetch;
globalThis.fetch = mock(() => Promise.resolve(new Response()));

afterAll(() => {
  globalThis.fetch = originalFetch;
});
// Benefits: tests URL construction, error handling, etc.
```

## Evaluation Criteria

### Test Validity

- Tests verify **requirements**, not implementation details
- Assertions are meaningful and specific
- Test names clearly describe what is being tested
- Tests would fail if production code behavior changes

### Coverage

- Happy path is covered
- Edge cases are considered (empty, null, boundary values)
- Error scenarios are tested
- Integration points are verified

### Methodology

- Mocks are used appropriately (not over-mocked)
- Test isolation is maintained
- Setup/teardown is clean
- Follows project testing guidelines

### Maintainability

- Tests are readable without excessive comments
- Duplication is minimized
- Test data is clear and purposeful

## Anti-Patterns to Avoid

### 1. Logic Duplication

Test file re-implements production logic instead of importing it.

**Signs:**
- Test-only classes that mirror production classes
- Functions in test files that do the same thing as production code
- Tests that wouldn't break when production code changes

### 2. Module-Level Mocking

Using `mock.module()` or `vi.mock()` instead of fetch-level mocks.

**Problems:**
- Bypasses actual API function logic (URL construction, error handling)
- `mock.module()` is permanent in bun:test (cannot be reset)
- Tests pass even when integration is broken

### 3. Private Method Testing

Attempting to test internal/private methods directly.

**Better approach:**
- Test through public interface
- If private method is complex enough to test, consider extracting to a separate module

### 4. Boundary Testing Gaps

Missing client-server boundary tests for forms.

**Catches:**
- `null` vs `undefined` mismatches
- JSON serialization issues
- Schema validation mismatches

### 5. Form Testing Gaps

Schema unit tests only (insufficient).

**Required:**
- Actual form interaction tests
- Conditional field tests (hidden fields don't block submission)
- Empty default value handling
- Validation error message verification

## Form Component Testing

Forms using React Hook Form + Valibot require component-level tests.

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

### Verify Error Messages

```typescript
// ❌ Insufficient: only checks error existence
expect(screen.getByRole('alert')).toBeTruthy();

// ✅ Correct: verifies message content
expect(screen.getByText('Branch name is required')).toBeTruthy();
```

### Explicitly Test "Cannot Submit" Cases

```typescript
it('should NOT call onSubmit when validation fails', async () => {
  await user.click(submitButton);
  expect(onSubmit).not.toHaveBeenCalled();
});
```

## Client-Server Boundary Testing

Test that client sends correct data AND server accepts it correctly.

### Why It Matters

```typescript
// Bug: undefined is omitted in JSON
activityPatterns: askingPatterns ? { askingPatterns } : undefined
// JSON.stringify({ activityPatterns: undefined }) → "{}"
// Server receives nothing, keeps old value instead of clearing
```

Unit tests on client or server alone cannot catch this.

### Server Bridge Pattern

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

## Pre-Implementation Checklist

Before writing tests, verify:

- [ ] Importing production code directly (not duplicating logic)
- [ ] Testing through public interface (not private methods)
- [ ] Mocking at lowest level (fetch, WebSocket, not modules)
- [ ] Not following existing bad patterns blindly
- [ ] Not changing production code just for testing without discussion
