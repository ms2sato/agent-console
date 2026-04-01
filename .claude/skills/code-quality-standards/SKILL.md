---
name: code-quality-standards
description: Code quality evaluation criteria for reviews. Use when reviewing code design, architecture, maintainability, or identifying potential issues.
---

# Code Quality Standards

## 1. Robustness to Change
- **Single Responsibility Principle** — Each module/class has only one reason to change. Unrelated concerns are separated.
- **File Size and Responsibility Checks** — Flag files >500 lines. Look for responsibility clustering (e.g., mixed prefixes like `initializeWorker*` vs `createSession*`). Note: responsibility clustering is the primary signal, not raw line count.
- **Module Design** — Evaluate cohesion, coupling, and encapsulation. See "Design Review Mindset" in CLAUDE.md for detailed module evaluation criteria.
- **Open-Closed Principle** — New features addable without modifying existing code.
- **Change Localization** — Single feature change contained within a small area. Watch for Shotgun Surgery.
- **Dependency Management** — Dependencies injected, loosely coupled, abstracted via interfaces.
- **Encapsulation** — Implementation details hidden behind stable interfaces.

## 2. Bug Resistance
- **Type Safety** — Types make invalid states unrepresentable. `any` avoided, `unknown` with proper type guards.
- **Exhaustive Type Handling** — All discriminated union cases explicitly handled. Never use bare `else` for last case — use explicit type check + `never` exhaustive guard. Red flag: `else { ... }` handling a union type.
- **Null Safety** — Nullability explicit in types, null checks at boundaries.
- **Error Handling** — Errors handled explicitly, error paths tested, propagation consistent.
- **Input Validation** — Validated at system boundaries, "parse, don't validate" principle.

## 3. Readability
- **Naming** — Reveals intent, not implementation. Abbreviations avoided unless universally known.
- **Magic Numbers and Literals** — Numeric/string literals given meaningful names. Use `as const` arrays with helper functions for enum-like sets.
- **Function Design** — Each function does one thing. Consistent abstraction level.
- **Code Organization** — Related code colocated, intuitive file structure, cohesive modules.

## 4. Simplicity
- **YAGNI** — No code for hypothetical future requirements, unused abstractions, or unjustified configurability.
- **Accidental Complexity** — No unnecessary indirection, no cargo-culted design patterns.
- **Cognitive Load** — New team member can understand quickly, no hidden assumptions.

## 5. Consistency
- **Patterns** — Similar problems solved similarly. Established patterns followed or intentionally improved.
- **Existing Pattern Evaluation** — Is the pattern appropriate? Copied without understanding? Outdated or misapplied?
- **API Design** — Function signatures consistent, return types predictable, error handling uniform.

## 6. Testability
- **Isolation** — Units testable in isolation, side effects contained, dependencies injectable.
- **Observability** — Behavior verifiable through outputs, edge cases distinguishable.
- **Test-Only Exports** — Use `@internal Exported for testing` JSDoc tag. Prefer extracting testable logic over exposing private state.

## 7. Performance Awareness
- **Algorithmic Efficiency** — Appropriate data structures, reasonable complexity, no obvious O(n²) that could be O(n).
- **Resource Management** — Resources properly cleaned up, reasonable memory allocation, caching where appropriate.

## 8. Security Mindset
- **OWASP Top 10** — Input sanitized, queries parameterized, output encoded.
- **Least Privilege** — Permissions minimized, secrets handled securely.
- **Project-Specific** — PTY command execution (no unsanitized user input), path traversal (validate boundaries), WebSocket security (validate message format, don't trust client IDs, rate-limit reconnection).

## 9. TypeScript Standards
- **Type Safety** — Avoid `any`, use `unknown` with guards. No `unknown` as shortcut (`value as unknown as T` prohibited). Shared types in `packages/shared`. Always `async/await`, no fire-and-forget.
- **Enum-like Definitions** — Define labeled object first, derive type with `keyof typeof`. Avoid separate type + labels (can drift).

See [code-quality-standards.md](code-quality-standards.md) for implementation examples and code patterns (used by coding agents).
