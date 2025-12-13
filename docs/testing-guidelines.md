# Testing Guidelines

## Principles

### 1. Tests Must Test Production Code

The purpose of tests is to verify the correctness of production code. The following is a wrong approach:

```typescript
// ❌ Wrong: Duplicating logic in test file
function cleanupOrphanProcesses(
  persistenceService: MockPersistenceService,
  isProcessAlive: (pid: number) => boolean,
  killProcess: (pid: number) => void
) {
  // Duplicating the same logic as production code...
}

// Testing this function does NOT test the production code
```

Correct approach:

```typescript
// ✅ Correct: Import and test production code directly
import { SomeClass } from '../some-class';

describe('SomeClass', () => {
  it('should do something', () => {
    const instance = new SomeClass();
    expect(instance.doSomething()).toBe(expected);
  });
});
```

### 2. Do Not Unilaterally Change Production Code for Testing

Changing production code interfaces to make testing easier should not be done without discussion.

```typescript
// ❌ Wrong: Adding optional dependency injection just for testing without discussion
class SessionManager {
  cleanupOrphanProcesses(
    deps: {
      loadSessions?: () => PersistedSession[];
      isProcessAlive?: (pid: number) => boolean;
    } = {}
  ): void {
    // Changed signature just for testing
  }
}
```

If you find that testing requires changes to production code, **consult with the team first**. Changes that improve testability often also improve design (e.g., dependency injection), but this should be a deliberate decision, not an afterthought.

### 3. Do Not Directly Test Private Methods

If you feel the need to test a private method, it's a sign to reconsider the design.

```typescript
// ❌ Wrong: Trying to test private method directly
// cleanupOrphanProcesses is private so it's not accessible
// → End up duplicating logic to test it

// ✅ Correct: Test through public interface
describe('SessionManager', () => {
  it('should cleanup orphan processes on initialization', () => {
    // Test constructor behavior
    // Mock at the communication layer (fetch, WebSocket, etc.) if needed
  });
});
```

## Testing Techniques

### Mocking Strategy: Prefer Low-Level Mocks

**Mock at the lowest level possible** (e.g., `fetch`, `WebSocket`, file system) rather than mocking intermediate modules.

#### Why Avoid Module-Level Mocking

Module-level mocking (`mock.module()` in bun:test, `vi.mock()` in vitest) should be avoided because:

1. **Fragile tests**: Tests break when internal implementation changes, even if behavior is correct
2. **False confidence**: Tests pass even when integration between modules is broken
3. **Global pollution**: In bun:test, `mock.module()` cannot be undone and affects all test files in the same process

#### ✅ Correct: Mock at the Communication Layer

```typescript
import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';

// Mock fetch at the global level
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('MyComponent', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should handle API response', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ data: 'test' })));

    // Test the component - actual API functions run, only fetch is mocked
    // This tests URL construction, error handling, etc.
  });
});
```

Benefits:
- API function logic (URL encoding, error handling) is actually tested
- Refactoring API internals doesn't break tests
- No global module pollution

#### ❌ Avoid: Module-Level Mocking

```typescript
// Don't do this unless absolutely necessary
import { mock } from 'bun:test';

mock.module('../lib/api', () => ({
  deleteWorktree: mock(() => Promise.resolve()),
  fetchSessions: mock(() => Promise.resolve({ sessions: [] })),
}));
```

Problems:
- Bypasses actual API function logic
- Tests don't catch bugs in URL construction or error handling
- `mock.module()` is permanent in bun:test (cannot be reset between tests)

### Integration Tests

When testing with actual dependencies:

```typescript
describe('Integration: SessionManager', () => {
  let testConfigDir: string;

  beforeEach(() => {
    // Set up temporary directory for testing
    testConfigDir = path.join(os.tmpdir(), 'test-' + Date.now());
    process.env.AGENT_CONSOLE_HOME = testConfigDir;
  });

  afterEach(() => {
    // Cleanup
    fs.rmSync(testConfigDir, { recursive: true });
    delete process.env.AGENT_CONSOLE_HOME;
  });

  it('should persist sessions', () => {
    // Uses actual PersistenceService
  });
});
```

## Form Component Testing

Forms using React Hook Form + Valibot require component-level tests. Schema unit tests alone are insufficient because they cannot catch integration issues between the form library and validation.

### 1. Write Component Tests for Forms

```typescript
// ❌ Insufficient: schema unit test only
describe('CreateWorktreeFormSchema', () => {
  it('should validate correctly', () => {
    const result = v.safeParse(schema, data);
    expect(result.success).toBe(true);
  });
});

// ✅ Required: actual form interaction test
describe('CreateWorktreeForm', () => {
  it('should submit with valid data', async () => {
    const user = userEvent.setup();
    await user.type(input, 'value');
    await user.click(submitButton);
    expect(onSubmit).toHaveBeenCalled();
  });
});
```

### 2. Test Conditional Fields When Hidden

When fields are conditionally shown/hidden, verify that hidden fields do not block form submission.

```typescript
// customBranch is hidden in prompt mode
// Verify hidden field doesn't prevent submission
it('should submit in prompt mode without customBranch', async () => {
  await user.type(promptInput, 'Some prompt');
  await user.click(submitButton);
  expect(onSubmit).toHaveBeenCalled();
});
```

### 3. Test Submission with Empty Default Values

React Hook Form uses empty strings in `defaultValues`. Test that validation handles this correctly.

```typescript
it('should show validation error when submitting with empty default value', async () => {
  // Submit immediately - field is '' from defaultValues
  await user.click(submitButton);

  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByText(/required/)).toBeTruthy();
});
```

### 4. Test Validation Error Messages

Verify that the **correct message** is displayed, not just that an error exists.

```typescript
// ❌ Insufficient: only checks error existence
expect(screen.getByRole('alert')).toBeTruthy();

// ✅ Correct: verifies message content
expect(screen.getByText('Branch name is required')).toBeTruthy();
```

### 5. Explicitly Test "Cannot Submit" Cases

When validation fails, explicitly verify that `onSubmit` is NOT called.

```typescript
it('should NOT call onSubmit when validation fails', async () => {
  await user.click(submitButton);

  // Explicitly test that it was NOT called
  expect(onSubmit).not.toHaveBeenCalled();
});
```

## Anti-Patterns

### 1. Logic Duplication

```typescript
// ❌ Re-implementing production logic in test file
class TestPersistenceService {
  // Writing the same logic as PersistenceService
}

class TestRepositoryManager {
  // Writing the same logic as RepositoryManager
}
```

Problems:
- Tests won't break when production code changes (tests become meaningless)
- Risk of divergence between production and test code
- Maintenance cost doubles

### 2. Following Existing Bad Patterns

Do not imitate bad patterns even if existing test code uses them.

```typescript
// Existing code (bad example)
// repository-manager.test.ts uses TestRepositoryManager

// ❌ Writing new tests with the same pattern
// session-manager-cleanup.test.ts creates similar duplication
```

## Checklist

Before writing tests, verify:

- [ ] Are you importing production code directly?
- [ ] Are you NOT duplicating logic?
- [ ] Are you NOT trying to test private methods directly?
- [ ] Are you NOT changing production code just for testing?
- [ ] Are you NOT following existing bad patterns?
- [ ] Are you mocking at the lowest level (fetch, WebSocket) instead of module-level?

## References

- [Bun Test Mocking](https://bun.sh/docs/test/mocks)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
