# Diff Review Annotations Design

Annotation system that allows an orchestrator agent to mark specific sections of a diff as "needs review", enabling the owner to review only judgment-critical parts instead of the entire changeset.

## Problem

### Owner review doesn't scale with PR volume

In a CTO-delegated workflow, the orchestrator agent performs acceptance checks on PRs before requesting owner review. Most changes in a PR are mechanical (import fixes, mock additions, formatting) and don't require owner judgment. Currently, the owner must scroll through the full diff to find the parts that matter.

As the team ships more PRs per sprint, the owner's review burden scales linearly with total diff size rather than with the number of actual judgment calls.

### No way to communicate "what to look at"

The orchestrator has no structured way to tell the owner "review these 3 sections and here's why." The knowledge of what matters is in the orchestrator's context and is lost when it finishes its review.

## Design Overview

```text
Orchestrator Agent                    Server                          Client (DiffWorker)
    |                                   |                                   |
    | write_review_annotations()       |                                   |
    | (MCP tool)                       |                                   |
    | -------------------------------->|                                   |
    |                                   |                                   |
    |                                   | 1. Validate workerId              |
    |                                   | 2. Store annotations              |
    |                                   |    (AnnotationService)            |
    |                                   | 3. Notify via WebSocket:          |
    |                                   |    annotations-updated            |
    |                                   | -------------------------------->|
    |                                   |                                   |
    |  { annotationId, count }          |                                   | Re-render with
    | <---------------------------------|                                   | filtered view
    |                                   |                                   |
```

```text
Owner (Browser)                       Server                          (future)
    |                                   |
    | POST /annotations                |
    | (REST API — future)              |
    | -------------------------------->|
    |                                   |
    |                                   | Same AnnotationService
    |                                   |
```

Key principle: **AnnotationService is the single source of truth.** MCP tools and future REST APIs are thin adapters that call the service.

## Design Decisions

### Decision 1: Domain service, not MCP-embedded logic

Annotation CRUD is implemented as `AnnotationService` in the service layer. MCP tools and future REST endpoints are thin adapters.

| Aspect | MCP-embedded (rejected) | Service layer (chosen) |
|--------|:-:|:-:|
| Human UI entry point | Must duplicate logic | Call same service |
| Testability | Requires MCP server setup | Unit-testable in isolation |
| Consistency with codebase direction | Deepens existing problem | Follows refactored pattern |

This aligns with the ongoing refactor to extract orchestration from MCP handlers into services (see `refactor/extract-worktree-orchestration` branch).

### Decision 2: Annotations are per-worker, not per-PR

Annotations are associated with a GitDiffWorker instance via `workerId`. The system has no concept of "PR" — DiffWorker shows diffs between a base commit and a target ref. Annotations attach to that specific diff view.

- No need to introduce PR as a domain concept
- The orchestrator already knows the workerId of the DiffWorker it's reviewing
- If the same PR is viewed in a different DiffWorker, it gets its own annotations (or none)

### Decision 3: Replace semantics, not append

Each `write_review_annotations` call replaces all annotations for that worker. There is no append or partial update.

Rationale:
- The orchestrator reviews the diff as a whole and produces a complete set of annotations
- If code changes and annotations become stale, the orchestrator re-runs and produces a fresh complete set
- Eliminates the complexity of annotation identity, partial updates, and orphan cleanup

### Decision 4: Annotations reference file paths and line ranges in the diff

```typescript
interface ReviewAnnotation {
  file: string;        // File path as shown in the diff
  startLine: number;   // Start line in the NEW file (1-based, inclusive)
  endLine: number;     // End line in the NEW file (1-based, inclusive)
  reason: string;      // Why this section needs review (shown in UI)
}

interface ReviewAnnotationSet {
  workerId: string;
  annotations: ReviewAnnotation[];
  summary: {
    totalFiles: number;       // Total files in the diff
    reviewFiles: number;      // Files with annotations
    mechanicalFiles: number;  // Files without annotations
    confidence: 'high' | 'medium' | 'low';
  };
  createdAt: string;  // ISO timestamp
}
```

Line numbers refer to the NEW file (right side of the diff), since that's what the reviewer cares about — "look at lines 42-58 of the new version."

### Decision 5: No line-number drift compensation

Annotations are a point-in-time snapshot. If the code changes after annotation, the line numbers may drift. This is acceptable because:

- The orchestrator (an AI) can cheaply re-generate annotations
- The cost of re-running `write_review_annotations` is negligible
- System-level drift compensation adds complexity for no practical benefit

### Decision 6: In-memory storage with WebSocket delivery

Annotations are stored in memory on the server, keyed by workerId. They are delivered to the client via the existing GitDiffWorker WebSocket connection.

No file persistence is needed because:
- Annotations are tied to a specific diff state, which changes frequently
- If the server restarts, the orchestrator can re-generate annotations
- DiffWorker already re-fetches state on reconnection

### Decision 7: Filtered view with full-diff toggle

The DiffWorker UI defaults to showing only annotated sections when annotations exist. A toggle allows the owner to see the full diff for spot-checking.

| View state | What is shown |
|-----------|---------------|
| No annotations | Full diff (current behavior, unchanged) |
| Annotations + filtered (default) | Only annotated hunks, with reason headers |
| Annotations + full view (toggle) | Full diff, annotated sections highlighted |

## AnnotationService

### Interface

```typescript
class AnnotationService {
  /** Replace all annotations for a worker. */
  setAnnotations(workerId: string, data: ReviewAnnotationInput): ReviewAnnotationSet;

  /** Get annotations for a worker, or null if none. */
  getAnnotations(workerId: string): ReviewAnnotationSet | null;

  /** Clear annotations for a worker. */
  clearAnnotations(workerId: string): void;
}
```

### Input validation

- `workerId` must correspond to an existing GitDiffWorker
- `annotations` array: each entry must have non-empty `file`, valid line range (`startLine <= endLine`, both >= 1), non-empty `reason`
- `summary.totalFiles` >= `summary.reviewFiles` + `summary.mechanicalFiles`
- `summary.confidence` must be one of `'high' | 'medium' | 'low'`

### Lifecycle

- Annotations are cleared when the worker is destroyed
- Annotations are cleared when `clearAnnotations` is called explicitly
- No automatic expiration

## MCP Tool

### `write_review_annotations`

```typescript
// Input
{
  workerId: string;         // Target GitDiffWorker ID
  sessionId: string;        // Session containing the worker
  annotations: Array<{
    file: string;
    startLine: number;
    endLine: number;
    reason: string;
  }>;
  summary: {
    totalFiles: number;
    reviewFiles: number;
    mechanicalFiles: number;
    confidence: 'high' | 'medium' | 'low';
  };
}

// Output (success)
{
  workerId: string;
  annotationCount: number;
  createdAt: string;
}

// Output (error)
// - Session not found
// - Worker not found or not a git-diff worker
// - Validation errors (invalid line ranges, etc.)
```

### `clear_review_annotations`

```typescript
// Input
{
  workerId: string;
  sessionId: string;
}

// Output (success)
{ cleared: true }
```

## WebSocket Protocol

### Server → Client message

When annotations are set or cleared, the server sends a message on the existing GitDiffWorker WebSocket connection (`/ws/session/:sessionId/worker/:workerId`):

```typescript
// Annotations updated
{
  type: 'annotations-updated';
  annotations: ReviewAnnotationSet | null;  // null = cleared
}
```

### Client → Server message

```typescript
// Request current annotations (e.g., on reconnect)
{
  type: 'get-annotations';
}
```

This fits into the existing message protocol alongside `refresh`, `set-base-commit`, `set-target-commit`, and `get-file-lines`.

## Client UI

### Summary bar

Displayed at the top of the DiffWorker when annotations exist:

```
Orchestrator reviewed 19 files. 2 need your attention. [Show full diff]
                                                        ^^^^^^^^^^^^^^^^ toggle
```

Includes confidence indicator from the summary.

### Filtered view (default when annotations exist)

- Only hunks overlapping annotated line ranges are shown
- Each annotated section has a header showing the orchestrator's reason
- Non-annotated files are collapsed with a "Verified by orchestrator" indicator
- File list sidebar highlights annotated files

### Full view (toggle)

- Complete diff as currently shown
- Annotated sections are visually highlighted (e.g., colored left border)
- Reason text shown inline next to annotated sections

## Workflow

```text
1. Coding agent creates changes in a worktree
2. Owner (or orchestrator) opens DiffWorker to see the diff
3. Orchestrator agent reviews the full diff (via terminal or DiffWorker)
4. Orchestrator calls write_review_annotations MCP tool:
   - Specifies which file/line-ranges need owner review
   - Provides reason for each annotation
   - Summarizes how many files are mechanical vs. review-needed
5. DiffWorker receives annotations via WebSocket
6. DiffWorker switches to filtered view automatically
7. Owner reviews only the flagged sections
8. Owner can toggle to full diff to spot-check orchestrator's judgment
9. If code changes, orchestrator re-runs and calls write_review_annotations again
```

## Future Extensions

### REST API for human annotations (planned)

```
POST   /api/sessions/:sessionId/workers/:workerId/annotations
GET    /api/sessions/:sessionId/workers/:workerId/annotations
DELETE /api/sessions/:sessionId/workers/:workerId/annotations
```

These endpoints call the same `AnnotationService`. This enables a future UI where the owner can add their own annotations or edit the orchestrator's annotations directly from the browser.

### Annotation persistence (if needed)

If server restarts become disruptive, annotations can be persisted to the session data directory. The `ReviewAnnotationSet` is already a serializable structure. This is deferred until there's a demonstrated need.

## Related Documents

- [Session-Worker Design](./session-worker-design.md) - Worker types and lifecycle
- [WebSocket Protocol](./websocket-protocol.md) - Real-time client communication
- [Inter-Session Messaging](./inter-session-messaging.md) - Similar pattern: MCP tool → service → delivery
