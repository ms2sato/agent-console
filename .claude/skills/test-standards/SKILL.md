---
name: test-standards
description: Testing best practices and anti-patterns. Use when writing tests, reviewing test quality, or understanding testing methodology for this project.
---

# Test Standards

Refer to [test-standards.md](test-standards.md) for detailed testing guidelines.

## Key Principles

1. **Test Validity** - Tests verify requirements, not implementation details
2. **Coverage** - Happy path, edge cases, error scenarios, integration points
3. **Methodology** - Appropriate mocking, test isolation, clean setup/teardown
4. **Maintainability** - Readable tests, minimal duplication, clear test data

## Anti-Patterns to Avoid

- Logic duplication (re-implementing production logic in tests)
- Module-level mocking (prefer fetch-level mocks)
- Private method testing (test through public interface)
- Boundary testing gaps (client-server, null vs undefined)
- Form testing gaps (schema-only tests are insufficient)
