---
description: Run automated parallel review loop with all reviewers until CRITICAL/HIGH issues are resolved
model: sonnet
---

You are coordinating a **parallel** code review and fix system optimized for maximum efficiency.

## Architecture Overview

```
[Phase 1: Parallel Review + Real-time Fix]
Reviewer 1 (bg) ──┐
Reviewer 2 (bg) ──┼─→ Write issues to own file
Reviewer 3 (bg) ──┘   - test-reviewer.jsonl
                      - code-quality-reviewer.jsonl
                      - ux-architecture-reviewer.jsonl
         ↓
Main Coordinator (polling)
  ├─ Read new issues from reviewer files
  ├─ Manage worker pool (2-3 workers)
  └─ Dispatch:
      ├─ Idle worker available → Direct assignment
      └─ All workers busy → Add to queue.jsonl

[Phase 2: Cleanup]
Process remaining queue
Collect final reports from reviewers
```

## Phase 1: Launch Reviewers

### Initialize

```bash
mkdir -p .claude/review-queue
rm -f .claude/review-queue/*.jsonl
```

### Launch All Reviewers in Parallel

Launch all three reviewers with `run_in_background=true` in a single message:

**Reviewer Prompt Template:**
```
Review [scope] for [criteria].

For EACH CRITICAL or HIGH severity single-file issue found:

1. Create JSON object:
{
  "severity": "CRITICAL|HIGH",
  "file": "relative/path/to/file.ts",
  "line": 123,
  "description": "Brief description",
  "recommendation": "How to fix"
}

2. Append to YOUR file using Write tool:
   - Read `.claude/review-queue/[reviewer-name].jsonl`
   - Append new JSON as a single line
   - Write back the entire content

**CRITICAL**:
- ONLY CRITICAL and HIGH severity
- ONLY single-file issues (fix within one file)
- ONE JSON object per line (JSONLines format)
- Use Write tool, NOT Bash

Other findings (MEDIUM/LOW, cross-file):
- Keep internal notes
- Report at the end in final summary

Continue reviewing ALL files in scope.
```

**Specific reviewer scopes:**
- `test-reviewer`: All test files, file=`.claude/review-queue/test-reviewer.jsonl`
- `code-quality-reviewer`: Production code, file=`.claude/review-queue/code-quality-reviewer.jsonl`
- `ux-architecture-reviewer`: UX architecture, file=`.claude/review-queue/ux-architecture-reviewer.jsonl`

## Phase 2: Real-time Fix Coordination

### Setup Worker Pool

Create 2-3 background fix workers:

```python
workers = {
  'frontend-1': None,  # agent ID when active
  'backend-1': None,
  'backend-2': None
}
```

### Polling Loop

```python
processed_counts = {
  'test-reviewer.jsonl': 0,
  'code-quality-reviewer.jsonl': 0,
  'ux-architecture-reviewer.jsonl': 0
}

while reviewers_running or new_issues_exist:
  # Check each reviewer file
  for file in reviewer_files:
    issues = read_new_issues(file, processed_counts[file])

    for issue in issues:
      idle_worker = find_idle_worker(workers, issue.file)

      if idle_worker:
        # Direct assignment
        assign_to_worker(idle_worker, issue)
      else:
        # Add to overflow queue
        append_to_queue('.claude/review-queue/queue.jsonl', issue)

    processed_counts[file] = get_line_count(file)

  sleep(10)  # Poll every 10 seconds
```

### Worker Assignment Logic

```python
def find_idle_worker(workers, file_path):
  # Determine component
  if file_path.startswith('packages/client'):
    component = 'frontend'
  elif file_path.startswith('packages/server'):
    component = 'backend'
  else:
    component = 'backend'  # shared defaults to backend

  # Find idle worker matching component
  for worker_id, task in workers.items():
    if task is None and worker_id.startswith(component):
      return worker_id

  return None

def assign_to_worker(worker_id, issue):
  # Launch fix worker with specific issue
  task_id = Task(
    subagent_type=get_specialist_type(worker_id),
    prompt=f"Fix this issue:\n{issue.description}\n\nFile: {issue.file}:{issue.line}\n\nRecommendation: {issue.recommendation}\n\nAfter fixing, verify with: bun run test",
    run_in_background=true
  )

  workers[worker_id] = task_id

def check_worker_completion(workers):
  for worker_id, task_id in workers.items():
    if task_id:
      result = TaskOutput(task_id, block=false)
      if result.status == 'completed':
        workers[worker_id] = None  # Mark as idle
```

## Phase 3: Monitor and Report

### Progress Display

Show periodic updates:

```
## Review Loop - Iteration 1

Reviewers: 3 running
Issues found: 12 (8 CRITICAL, 4 HIGH)
Workers: frontend-1 active, backend-1 active, backend-2 idle
Queue: 3 pending

[Update every 30 seconds]
```

### Completion Criteria

Wait until:
1. All reviewers completed
2. All issues processed (files empty + queue empty)
3. All workers idle

## Phase 4: Final Report

Collect from each reviewer:

```
TaskOutput(reviewer_id, block=true)
```

Extract final summaries including:
- Total issues found (all severities)
- MEDIUM/LOW recommendations
- Cross-file issues
- Statistics

## Phase 5: Verification

```bash
bun run test
```

If failures:
- Identify which fix caused it
- Retry or report to user

## Phase 6: Summary

```
## Review Loop Complete

### Iteration 1 Results
- CRITICAL resolved: {count}
- HIGH resolved: {count}
- Remaining MEDIUM: {count}
- Remaining LOW: {count}
- Cross-file issues: {count}

### Statistics
- Total issues found: {count}
- Fixed in parallel: {count}
- Average fix time: {estimate}
- Worker utilization: {percent}

### Next Steps
[Recommendations for remaining issues]
```

## Implementation Notes

### Reading New Issues

```python
def read_new_issues(file_path, last_count):
  content = Read(file_path)
  lines = content.split('\n')
  new_lines = lines[last_count:]

  issues = []
  for line in new_lines:
    if line.strip():
      issues.append(json.loads(line))

  return issues
```

### Queue Format

`.claude/review-queue/queue.jsonl`:
```jsonl
{"severity":"HIGH","file":"packages/server/src/file.ts","line":42,"description":"...","recommendation":"..."}
{"severity":"CRITICAL","file":"packages/client/src/App.tsx","line":10,"description":"...","recommendation":"..."}
```

## Error Handling

- **Reviewer crashes**: Continue with remaining reviewers
- **Worker fails**: Mark issue as failed, continue with next
- **Parse errors**: Log and skip malformed JSON
- **Timeout**: Set 10-minute max per reviewer

## Constraints

- Maximum 5 iterations
- Only auto-fix CRITICAL and HIGH
- Only single-file issues auto-fixed
- Always verify with tests

Begin Phase 1 now.
