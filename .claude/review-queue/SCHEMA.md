# Review Queue Schema

This directory contains the parallel review and fix queue system.

## File Structure

```
.claude/review-queue/
├── single-file.jsonl    # Single-file issues (parallel fix)
├── cross-file.jsonl     # Cross-file issues (sequential fix)
├── fixing.json          # Currently locked files
└── SCHEMA.md            # This file
```

## Issue Format (JSONL)

Each line in `single-file.jsonl` or `cross-file.jsonl` is a JSON object:

```json
{
  "id": "issue-1",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "reviewer": "test-reviewer|code-quality-reviewer|ux-architecture-reviewer",
  "file": "packages/client/src/App.tsx",
  "line": 42,
  "description": "Detailed description of the issue",
  "recommendation": "Suggested fix",
  "status": "pending|in_progress|fixed|failed",
  "timestamp": "2025-12-25T15:30:00.000Z"
}
```

### Single-file vs Cross-file

**Single-file** (`single-file.jsonl`):
- Fix is contained within one file
- Safe for parallel processing
- Examples: type errors, null checks, single function refactoring

**Cross-file** (`cross-file.jsonl`):
- Fix spans multiple files
- Processed sequentially after all single-file fixes
- Examples: API contract changes, function renames used in multiple files

## Lock Format (JSON)

`fixing.json` tracks which files are currently being modified:

```json
{
  "packages/client/src/App.tsx": {
    "worker": "frontend-specialist-a91f",
    "issueId": "issue-1",
    "timestamp": "2025-12-25T15:30:00.000Z"
  },
  "packages/server/src/session.ts": {
    "worker": "backend-specialist-b82e",
    "issueId": "issue-5",
    "timestamp": "2025-12-25T15:30:15.000Z"
  }
}
```

## Status Values

- `pending` - Issue identified, not yet being fixed
- `in_progress` - Currently being fixed by a worker
- `fixed` - Successfully fixed
- `failed` - Fix attempt failed

## Workflow

1. **Reviewers** append issues to `.jsonl` files as they find them
2. **Fix workers** read `single-file.jsonl`, check locks, fix issues
3. **Main coordinator** processes `cross-file.jsonl` after all single-file fixes complete
