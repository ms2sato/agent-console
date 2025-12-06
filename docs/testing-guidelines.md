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
import { SomeClass } from '../some-class.js';

describe('SomeClass', () => {
  it('should do something', () => {
    const instance = new SomeClass();
    expect(instance.doSomething()).toBe(expected);
  });
});
```

### 2. Do Not Change Production Code Specifications for Testing

Changing production code interfaces to make testing easier is putting the cart before the horse.

```typescript
// ❌ Wrong: Adding optional dependency injection just for testing
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

Exception: Adopting dependency injection at the design stage is good. However, it should be "for good design," not "for testing."

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
    // Use vi.mock to mock dependencies if needed
  });
});
```

## Testing Techniques

### Module-Level Mocking

The correct way to mock external dependencies:

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock the entire module
vi.mock('../services/persistence-service.js', () => ({
  persistenceService: {
    loadSessions: vi.fn(() => [
      { id: 'test-session', pid: 12345, serverPid: 99999 }
    ]),
    saveSessions: vi.fn(),
  },
}));

// Import production code (mock is applied)
import { SessionManager } from '../services/session-manager.js';

describe('SessionManager', () => {
  it('should work with mocked dependencies', () => {
    const manager = new SessionManager();
    // ...
  });
});
```

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

## References

- [Vitest Mocking](https://vitest.dev/guide/mocking.html)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
