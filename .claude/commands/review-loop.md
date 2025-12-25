---
description: Run automated parallel review loop with all reviewers until CRITICAL/HIGH issues are resolved
model: sonnet
---

You are coordinating an automated review and fix loop. Your role is to orchestrate reviewers and specialists to iteratively improve code quality.

## Overview

1. Launch 3 reviewers in parallel (background)
2. Collect their findings
3. If CRITICAL/HIGH issues exist → Fix them with specialists
4. Re-review after fixes
5. Repeat until no CRITICAL/HIGH issues remain (max 5 iterations)

## Iteration Loop

For each iteration (max 5):

### Step 1: Launch Reviewers in Parallel

Launch all three reviewers with `run_in_background=true` in a **single message**:

**test-reviewer:**
```
Review all test files for test quality, coverage, and anti-patterns.

Report ALL issues found with their severity levels (CRITICAL, HIGH, MEDIUM, LOW).

For CRITICAL and HIGH severity issues, provide:
- Severity level
- File path and line number
- Clear description of the problem
- Specific recommendation for fixing

Format your findings clearly so they can be easily identified and addressed.
```

**code-quality-reviewer:**
```
Review production code for design quality, maintainability, and adherence to project patterns.

Report ALL issues found with their severity levels (CRITICAL, HIGH, MEDIUM, LOW).

For CRITICAL and HIGH severity issues, provide:
- Severity level
- File path and line number
- Clear description of the problem
- Specific recommendation for fixing

Format your findings clearly so they can be easily identified and addressed.
```

**ux-architecture-reviewer:**
```
Review for UX architecture issues: state consistency, WebSocket/REST API contracts, session/worker lifecycle handling, and edge cases.

Report ALL issues found with their severity levels (CRITICAL, HIGH, MEDIUM, LOW).

For CRITICAL and HIGH severity issues, provide:
- Severity level
- File path and line number
- Clear description of the problem
- Specific recommendation for fixing

Format your findings clearly so they can be easily identified and addressed.
```

### Step 2: Collect Results

Use `TaskOutput` with `block=true` to wait for each reviewer to complete:

```
test_result = TaskOutput(test_reviewer_id, block=true)
quality_result = TaskOutput(quality_reviewer_id, block=true)
ux_result = TaskOutput(ux_reviewer_id, block=true)
```

### Step 3: Extract CRITICAL/HIGH Issues

From each reviewer's output, identify all CRITICAL and HIGH severity issues.

Group issues by component:
- `packages/client/**` → frontend issues
- `packages/server/**` → backend issues
- `packages/shared/**` → classify based on primary consumer

### Step 4: Fix Issues

If CRITICAL/HIGH issues exist:

**For frontend issues:**
Launch `frontend-specialist` with the list of issues to fix:
```
Fix the following CRITICAL/HIGH issues in packages/client:

[List all frontend issues with file, line, description, and recommendation]

After fixing each issue:
1. Ensure the fix addresses the root cause
2. Update related tests if needed
3. Verify code still follows frontend standards

After all fixes, run: bun run test
```

**For backend issues:**
Launch `backend-specialist` with the list of issues to fix:
```
Fix the following CRITICAL/HIGH issues in packages/server:

[List all backend issues with file, line, description, and recommendation]

After fixing each issue:
1. Ensure the fix addresses the root cause
2. Update related tests if needed
3. Verify code still follows backend standards

After all fixes, run: bun run test
```

**Note:** If you have both frontend and backend issues, launch both specialists **in parallel** in a single message.

### Step 5: Verify Fixes

After specialists complete, verify:
1. All CRITICAL/HIGH issues were addressed
2. Tests pass (`bun run test`)
3. No new issues were introduced

### Step 6: Decide Next Action

- **If CRITICAL/HIGH issues remain:** Start next iteration
- **If no CRITICAL/HIGH issues:** Exit loop (success)
- **If max iterations (5) reached:** Exit loop and report remaining issues

## Final Report

After the loop completes, provide a summary:

```
## Review Loop Complete - Iteration {N}

### Results
- CRITICAL issues resolved: {count}
- HIGH issues resolved: {count}
- Remaining MEDIUM issues: {count}
- Remaining LOW issues: {count}

### Iterations Summary
{Brief summary of what was fixed in each iteration}

### Remaining Issues
{List of MEDIUM/LOW issues that weren't auto-fixed}

### Verification
- All tests passing: {yes/no}
- Type check passing: {yes/no}
```

## Error Handling

- **Reviewer fails:** Continue with remaining reviewers, report the failure
- **Specialist fails:** Report the failure, continue to next iteration to retry
- **Tests fail after fix:** Report which fix caused the failure, attempt to revert or fix in next iteration

## Important Notes

- **Primary agent role:** You (the primary agent) coordinate but do NOT write code directly. Delegate all fixes to specialists.
- **Parallel execution:** Launch reviewers in parallel (single message with 3 Task calls). Launch specialists in parallel when you have both frontend and backend issues.
- **Maximum iterations:** Stop after 5 iterations even if CRITICAL/HIGH issues remain
- **Focus:** Only auto-fix CRITICAL and HIGH severity issues
- **Verification:** Always run tests after fixes

## Begin Now

Start with Iteration 1: Launch all three reviewers in parallel.
