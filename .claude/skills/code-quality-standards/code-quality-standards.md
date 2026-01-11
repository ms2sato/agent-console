# Code Quality Standards

This document defines the evaluation criteria for code design and quality reviews.

## 1. Robustness to Change

### Single Responsibility Principle
- Does each module/class have only one reason to change?
- Are unrelated concerns separated into different modules?
- Would a change in one domain require changes in unrelated code?

### File Size and Responsibility Checks

**File Size Warning**: Flag files that exceed reasonable limits:
- \> 500 lines: Consider splitting into modules
- Look for natural boundaries (e.g., related functions/types that could be extracted)

**Responsibility Clustering**: Check if function/method names suggest multiple concerns:
- Prefixes like `initializeWorker*`, `activateWorker*` vs `createSession*` = extraction candidate
- A class/file doing two distinct things violates Single Responsibility Principle

Example red flags:
```typescript
// File: session-manager.ts (800+ lines)
// Contains both session management AND worker lifecycle
createSession()
deleteSession()
initializeAgentWorker()   // ← Different concern
activateWorker()          // ← Different concern
cleanupWorkerResources()  // ← Different concern
```

Consider extracting to `worker-lifecycle.ts` or similar.

### Open-Closed Principle
- Can new features be added without modifying existing code?
- Are extension points clearly defined?
- Is behavior parameterized rather than hardcoded?

### Change Localization
- Is a single feature change contained within a small area of code?
- Are there signs of Shotgun Surgery (one change requires many small edits across files)?
- Would adding a new variant require touching multiple unrelated files?

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

### Exhaustive Type Handling

When handling discriminated unions (e.g., `type: 'agent' | 'terminal' | 'git-diff'`):

1. **All cases must be explicitly handled** with `if/else if` or `switch`
2. **Never use bare `else` for the last case** - always use `else if` with explicit type check
3. **Add exhaustive check** to catch future type additions at compile time

```typescript
// ❌ Wrong: bare else hides bugs when new types are added
if (worker.type === 'agent') {
  // handle agent
} else if (worker.type === 'terminal') {
  // handle terminal
} else {
  // This silently handles 'git-diff' and any future types!
}

// ✅ Correct: explicit type check + exhaustive guard
if (worker.type === 'agent') {
  // handle agent
} else if (worker.type === 'terminal') {
  // handle terminal
} else if (worker.type === 'git-diff') {
  // handle git-diff
} else {
  const _exhaustive: never = worker.type;
  throw new Error(`Unknown worker type: ${worker.type}`);
}
```

**Red flag**: `else { ... }` handling a union type = implicit fallback that hides bugs

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

### Magic Numbers and Literals
- Are numeric literals given meaningful names via constants?
- Are string literals that represent domain concepts extracted to constants?
- Is it clear what each value represents without looking up context?
- Exception: 0, 1, -1, empty string, and other universally understood values are acceptable

**Preferred pattern: `as const` arrays with helper functions**

```typescript
// Define constants with literal types preserved
const NO_RECONNECT_CLOSE_CODES = [
  WS_CLOSE_CODE.NORMAL_CLOSURE,
  WS_CLOSE_CODE.GOING_AWAY,
  WS_CLOSE_CODE.POLICY_VIOLATION,
] as const;

/**
 * Determine if reconnection should be attempted for the given close code.
 * Add new codes to NO_RECONNECT_CLOSE_CODES to automatically update this logic.
 */
function isReconnectCode(code: number): boolean {
  // Cast array to readonly number[] to allow includes() with external close codes.
  // The literal types in NO_RECONNECT_CLOSE_CODES are preserved for type safety elsewhere.
  return !(NO_RECONNECT_CLOSE_CODES as readonly number[]).includes(code);
}
```

Key principles:
- Use `as const` to preserve literal types for type safety
- When array methods like `includes()` are needed, wrap in a domain-specific helper function
- Document why type casting is necessary in a comment
- The helper function name should reflect business logic, not the technical operation

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

### Existing Pattern Evaluation
- Is the existing pattern being followed actually appropriate for this use case?
- Does the pattern solve the problem well, or was it copied without understanding?
- Are there signs the pattern is outdated or misapplied?
- Would a different approach be more suitable than following the existing pattern?
- If deviating from an existing pattern, is the reason justified and documented?

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

### Test-Only Exports
When exporting internal functions or types solely for testing purposes, use `@internal` JSDoc tag with explanation:

```typescript
/**
 * Validate that a parsed message has a valid type.
 * @internal Exported for testing
 */
export function isValidClientMessage(msg: unknown): msg is AppClientMessage {
  // ...
}

/**
 * @internal Exported for testing
 */
export interface SomeDependencies {
  // ...
}
```

Key principles:
- Use `@internal Exported for testing` to clearly mark test-only exports
- Prefer extracting testable logic over exposing private state
- If a function needs to be exported for testing, consider if it should be a separate module
- Production code should only import non-internal exports

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

### Project-Specific Security Concerns

**PTY Command Execution**
- Commands passed to PTY should not be constructed from unsanitized user input
- Agent command templates should be validated before execution
- Environment variables passed to child processes should be filtered

**Path Traversal**
- Validate that session/worktree paths are within expected directories
- `AGENT_CONSOLE_HOME` directory access should be scoped appropriately
- File operations should use absolute paths and validate boundaries

**WebSocket Security**
- Validate message format before processing (use Valibot schemas)
- Don't trust client-provided IDs without verification
- Rate-limit rapid reconnection attempts

## Evaluation Output Format

For each aspect reviewed, provide:

1. **Rating**: Good / Acceptable / Needs Improvement / Critical Issue
2. **Evidence**: Specific code references (file:line)
3. **Impact**: What could go wrong if not addressed
4. **Recommendation**: Concrete suggestion for improvement
