---
paths:
  - "**/*.test.*"
  - "**/__tests__/**"
---

# Testing Rules

## Core Principles

1. **Tests Must Test Production Code** - Import and test production code directly. Never duplicate production logic in test files. Test-only classes that mirror production classes, or functions in test files that replicate production behavior, are signs of logic duplication.
2. **Test Through Public Interface** - If you feel the need to test a private method, reconsider the design. Test observable behavior via public API. If a private method is complex enough to warrant direct testing, consider extracting it to a separate module.
3. **Mock at the Lowest Level** - Mock at the communication layer (`fetch`, `WebSocket`, file system) rather than mocking intermediate modules. `mock.module()` is process-global in bun:test and pollutes all test files in the same process. Prefer dependency injection over module mocking for cross-cutting concerns.
4. **Do Not Change Production Code for Testing Without Discussion** - Changes that improve testability often also improve design, but this should be a deliberate decision, not an afterthought. Consult with the team first.

## Anti-Patterns

### 1. Logic Duplication
Test file re-implements production logic instead of importing it. Signs: test-only classes mirroring production classes, functions in test files doing the same thing as production code, tests that wouldn't break when production code changes.

### 2. Module-Level Mocking
Using `mock.module()` or `vi.mock()` instead of fetch-level mocks. Problems: bypasses actual API function logic, `mock.module()` is permanent in bun:test, tests pass even when integration is broken. Has caused production incidents (mocking `config.js` broke 26+ unrelated tests). **Preferred: dependency injection over module mocking.**

### 3. Private Method Testing
Attempting to test internal/private methods directly. Test through public interface instead, or extract to a separate module if complexity warrants it.

### 4. Boundary Testing Gaps
Missing client-server boundary tests for forms. Must catch: `null` vs `undefined` mismatches, JSON serialization issues, schema validation mismatches. Unit tests on client or server alone cannot catch these.

### 5. Form Testing Gaps
Schema unit tests alone are insufficient. Required: actual form interaction tests, conditional field tests (hidden fields don't block submission), empty default value handling, validation error message verification, explicit "cannot submit" cases.

## Test Strategy: Unit vs Integration

- **Unit tests**: Exhaustively cover all patterns defined in the spec (all event types, all handler cases)
- **Integration tests**: Verify pipeline connectivity with 1-2 representative events -- exhaustive coverage is the unit test's job
- These responsibilities must not be confused

## Test File Naming Convention

- Test files MUST be named after the production file they test: `foo-bar.ts` -> `__tests__/foo-bar.test.ts`
- Place test files in the `__tests__/` directory at the same level as the production file

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

### Maintainability
- Tests are readable without excessive comments
- Duplication is minimized
- Test data is clear and purposeful

## Pre-Implementation Checklist

Before writing tests, verify:
- [ ] Importing production code directly (not duplicating logic)
- [ ] Testing through public interface (not private methods)
- [ ] Mocking at lowest level (fetch, WebSocket, not modules)
- [ ] Not following existing bad patterns blindly
- [ ] Not changing production code just for testing without discussion
- [ ] **Target code is mockable via DI** — check if the code under test imports module-level singletons. If it does, DI refactoring is required before the test can be written safely. Do NOT use `mock.module()` to work around missing DI. See Anti-Pattern #2.
