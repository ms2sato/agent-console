---
description: Run automated parallel review loop with all reviewers until CRITICAL/HIGH issues are resolved
model: sonnet
---

You are coordinating a **parallel** code review and fix system. This system processes issues concurrently for maximum efficiency.

## Architecture Overview

```
[Phase 1: Parallel Review]
Reviewer 1 (bg) ──┐
Reviewer 2 (bg) ──┼─→ Append issues to queue as found
Reviewer 3 (bg) ──┘   ├→ single-file.jsonl (parallel fix)
                      └→ cross-file.jsonl (sequential fix)

[Phase 2: Parallel Single-File Fixes]
Fix Worker 1 ──┐
Fix Worker 2 ──┼─→ Process single-file queue concurrently
Fix Worker 3 ──┘   (file-level locking prevents conflicts)

[Phase 3: Sequential Cross-File Fixes]
Main coordinator → Process cross-file queue one by one
```

## Initialization

Before starting, initialize the queue system:

```bash
.claude/review-queue/queue-manager.sh init
```

## Phase 1: Launch All Reviewers (Background)

Launch all three reviewers **in parallel with run_in_background=true**:

### Task 1: test-reviewer
```
Review all test files for quality, coverage, and anti-patterns.

For each issue found, classify as single-file or cross-file:
- Single-file: Fix contained within one test file
- Cross-file: Fix requires changes to multiple files

Append to queue immediately using:
bash .claude/review-queue/queue-manager.sh add <type> <severity> test-reviewer <file> <line> "<description>"

Where:
- <type>: "single-file" or "cross-file"
- <severity>: "CRITICAL", "HIGH", "MEDIUM", "LOW"

Continue appending as you find issues. Do not wait until review is complete.
```

### Task 2: code-quality-reviewer
```
Review all production code for design, architecture, and patterns.

For each issue found, classify as single-file or cross-file:
- Single-file: Fix contained within one file (type error, null check, function logic)
- Cross-file: Fix spans multiple files (API changes, refactoring, renames)

Append to queue immediately using:
bash .claude/review-queue/queue-manager.sh add <type> <severity> code-quality-reviewer <file> <line> "<description>"

Continue appending as you find issues.
```

### Task 3: ux-architecture-reviewer
```
Review UX architecture for state consistency and edge cases.

For each issue found, classify as single-file or cross-file:
- Single-file: Fix in one component or service
- Cross-file: Fix requires client-server contract changes

Append to queue immediately using:
bash .claude/review-queue/queue-manager.sh add <type> <severity> ux-architecture-reviewer <file> <line> "<description>"

Continue appending as you find issues.
```

**Launch all three with run_in_background=true in a single message.**

## Phase 2: Parallel Single-File Fixes

While reviewers are running in the background, start processing the single-file queue.

### Launch Multiple Fix Workers

Create 2-3 fix worker agents that run this loop concurrently:

```
Fix Worker Loop:

1. Get next pending CRITICAL/HIGH issue:
   issue=$(bash .claude/review-queue/queue-manager.sh next)

2. If no issue, wait 10 seconds and retry (reviewers may still be working)

3. Extract file path from issue and check lock:
   bash .claude/review-queue/queue-manager.sh lock <file> <worker-id> <issue-id>

4. If lock failed, skip to next issue (another worker is fixing it)

5. Fix the issue based on file location:
   - packages/client/** → Use frontend-specialist
   - packages/server/** → Use backend-specialist

6. Update status and release lock:
   bash .claude/review-queue/queue-manager.sh update <issue-id> fixed
   bash .claude/review-queue/queue-manager.sh unlock <file>

7. Repeat until no more pending CRITICAL/HIGH issues
```

**Implementation:**

Launch 2-3 fix worker agents with run_in_background=true. Each worker should:
- Be a `frontend-specialist` or `backend-specialist` depending on component
- Run the fix loop independently
- Coordinate via the queue and lock files

## Phase 3: Wait and Monitor

Use TaskOutput to monitor background agents:

1. Check reviewers periodically - are they still finding issues?
2. Check fix workers - are they making progress?
3. Display progress:
   ```bash
   bash .claude/review-queue/queue-manager.sh count
   ```

## Phase 4: Verification

After all single-file CRITICAL/HIGH issues are fixed:

```bash
bun run test
```

If tests fail:
- Identify which fix caused the failure
- Mark issue as failed
- Optionally retry or ask user

## Phase 5: Cross-File Fixes

Process cross-file queue sequentially (one at a time):

```bash
# Get all pending CRITICAL/HIGH cross-file issues
grep '"severity":"CRITICAL"' .claude/review-queue/cross-file.jsonl | grep '"status":"pending"'
grep '"severity":"HIGH"' .claude/review-queue/cross-file.jsonl | grep '"status":"pending"'
```

For each issue:
1. Delegate to appropriate specialist (or both if needed)
2. Run `bun run test` after each fix
3. Update status

## Phase 6: Re-review Decision

After all fixes:

```bash
bash .claude/review-queue/queue-manager.sh count
```

Check remaining CRITICAL/HIGH issues:
- **If any remain** → Start next iteration (clean queue and restart)
- **If none remain** → Complete the loop
- **If iteration count reaches 5** → Stop and report

## Output Requirements

### Per-Phase Updates

Show progress after each phase:

```
## Phase 1: Review - In Progress
Reviewers running in background...
Issues queued so far: {count}

## Phase 2: Single-File Fixes - In Progress
Fix workers: 3 active
Pending: {count} | Fixed: {count}

## Phase 4: Verification
Tests: ✓/✗

## Phase 5: Cross-File Fixes
Processing {count} cross-file issues...
```

### Final Summary

```
## Review Loop Complete

Iterations: {N}

### Status
- CRITICAL issues resolved: ✓/✗
- HIGH issues resolved: ✓/✗
- Remaining MEDIUM: {count}
- Remaining LOW: {count}

### Statistics
- Total issues found: {count}
- Single-file (parallel): {count}
- Cross-file (sequential): {count}
- Fix time saved by parallelization: ~{estimate}

### Next Steps
[Recommendations for remaining MEDIUM/LOW issues]
```

## Constraints

- **Maximum 5 iterations**
- **Only auto-fix CRITICAL and HIGH** severity issues
- **Always delegate** to specialist agents
- **File-level locking** prevents conflicts
- **Use TodoWrite** to track progress

## Error Handling

If a fix worker fails:
1. Mark issue as failed in queue
2. Release lock
3. Continue with other issues
4. Report failures at end

If reviewers stall:
- Set reasonable timeout (e.g., 5 minutes)
- Process whatever issues were found
- Report incomplete review

## Tips for Efficiency

- Start fix workers early (don't wait for all reviews to complete)
- Use 2-3 fix workers for optimal parallelism
- Monitor queue counts to see progress
- Most issues should be single-file (~80%), so parallelization helps significantly

Begin Phase 1 now.
