# Code Quality Standards

This document defines the evaluation criteria for code design and quality reviews.

## 1. Robustness to Change

### Open-Closed Principle
- Can new features be added without modifying existing code?
- Are extension points clearly defined?
- Is behavior parameterized rather than hardcoded?

### Dependency Management
- Are dependencies injected rather than instantiated internally?
- Is the code loosely coupled to external systems?
- Are interfaces used to abstract volatile dependencies?

### Encapsulation
- Are implementation details hidden behind stable interfaces?
- Can internal structures change without affecting clients?
- Are data structures protected from direct manipulation?

## 2. Bug Resistance

### Type Safety
- Are types used to make invalid states unrepresentable?
- Is `any` avoided? Is `unknown` used with proper type guards?
- Are discriminated unions used for state management?

### Null Safety
- Is nullability explicit in types?
- Are null checks performed at boundaries, not scattered throughout?
- Is optional chaining used appropriately?

### Error Handling
- Are errors handled explicitly, not silently ignored?
- Are error paths tested?
- Is error propagation consistent (exceptions vs Result types)?

### Input Validation
- Is input validated at system boundaries?
- Are validation errors descriptive and actionable?
- Is the "parse, don't validate" principle applied?

## 3. Readability

### Naming
- Do names reveal intent, not implementation?
- Are abbreviations avoided unless universally known?
- Is naming consistent across the codebase?

### Function Design
- Does each function do one thing well?
- Are functions short enough to understand at a glance?
- Is the abstraction level consistent within a function?

### Code Organization
- Is related code colocated?
- Is the file structure intuitive?
- Are modules cohesive (high internal relatedness)?

## 4. Simplicity

### YAGNI (You Aren't Gonna Need It)
- Is there code for hypothetical future requirements?
- Are there unused abstractions or extension points?
- Is configurability justified by actual use cases?

### Accidental Complexity
- Is there unnecessary indirection?
- Are design patterns used appropriately (not cargo-culted)?
- Could the same result be achieved with less code?

### Cognitive Load
- Can a new team member understand this code quickly?
- Are there hidden assumptions that require tribal knowledge?
- Is control flow straightforward?

## 5. Consistency

### Patterns
- Are similar problems solved similarly?
- Are established project patterns followed or intentionally improved?
- Is the style consistent with the codebase?

### API Design
- Are function signatures consistent across the module?
- Are return types predictable?
- Is error handling uniform?

## 6. Testability

### Isolation
- Can units be tested in isolation?
- Are side effects contained and mockable?
- Are dependencies injectable?

### Observability
- Can the code's behavior be verified through outputs?
- Are internal states accessible for testing when needed?
- Are edge cases distinguishable?

## 7. Performance Awareness

### Algorithmic Efficiency
- Are appropriate data structures used?
- Is time/space complexity reasonable for the use case?
- Are there obvious O(n^2) or worse patterns that could be O(n)?

### Resource Management
- Are resources (connections, file handles) properly cleaned up?
- Is memory allocation reasonable?
- Are expensive operations cached when appropriate?

## 8. Security Mindset

### OWASP Top 10 Awareness
- Is user input sanitized before use?
- Are SQL queries parameterized?
- Is output encoded appropriately for context (HTML, JS, etc.)?

### Principle of Least Privilege
- Are permissions minimized?
- Are secrets handled securely (not in code, not logged)?
- Is authentication/authorization checked at proper boundaries?

## 9. React Best Practices

### Suspense Usage
- Is Suspense used for async data fetching and code splitting?
- Are loading states handled declaratively with Suspense boundaries?
- Is ErrorBoundary paired with Suspense for error handling?

### useEffect Discipline
- Is useEffect avoided when derived state or event handlers suffice?
- Are effects truly for synchronization with external systems?
- Could the logic be moved to event handlers, useMemo, or server components?
- Are unnecessary re-subscriptions avoided?

### Component Organization
- Are SVG icons extracted to a dedicated Icons.tsx component?
- Are View components kept clean of implementation details?
- Is presentational logic separated from business logic?

## Evaluation Output Format

For each aspect reviewed, provide:

1. **Rating**: Good / Acceptable / Needs Improvement / Critical Issue
2. **Evidence**: Specific code references (file:line)
3. **Impact**: What could go wrong if not addressed
4. **Recommendation**: Concrete suggestion for improvement
