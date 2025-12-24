# Local Job Queue Design

## Overview

A local job queue system with guaranteed delivery for background task processing. Jobs are persisted to SQLite and automatically retried until successful or max attempts reached.

## Background

This design was triggered by [Issue #129](https://github.com/ms2sato/agent-console/issues/129), which identified reliability issues with fire-and-forget patterns in async cleanup operations. A codebase audit revealed 14 locations using this pattern, of which 5 are suitable candidates for job queue migration.

## Requirements

- **Persistence**: Jobs survive process restarts
- **Guaranteed delivery**: Jobs eventually succeed or are marked for manual intervention
- **Efficiency**: Event-driven (no polling)
- **Retry with backoff**: Exponential backoff with configurable max attempts
- **Management UI**: View and manage stalled jobs

## Use Case Analysis

### Suitable for Job Queue ✅

| Location | Operation | Why Suitable |
|----------|-----------|--------------|
| `session-manager.ts` → `deleteOrphanSessions()` | Delete orphan session outputs | Idempotent file deletion, survives restart |
| `session-manager.ts` → `deleteSession()` | Delete session outputs on user delete | Idempotent file deletion, survives restart |
| `session-manager.ts` → `removeAgentWorker()` | Delete agent worker output | Idempotent file deletion, survives restart |
| `session-manager.ts` → `removeTerminalWorker()` | Delete terminal worker output | Idempotent file deletion, survives restart |
| `repository-manager.ts` → `cleanupRepositoryData()` | Cleanup repository data on unregister | Idempotent directory deletion, survives restart |

**Common characteristics:**
- Operations are **idempotent** (safe to retry)
- **No runtime context required** (just file paths)
- Failure accumulates **disk space waste**
- Can be **serialized to JSON** easily

### NOT Suitable for Job Queue ❌

| Location | Operation | Why NOT Suitable |
|----------|-----------|------------------|
| `worker-output-file.ts:71-82` | Buffer flush to disk | Data is in memory; job queue can't persist the buffer content itself |
| `routes.ts` (6 locations) | WebSocket handlers | Requires active WebSocket connection; context lost on restart |
| `git-diff-handler.ts:110-112` | Send diff on file change | Real-time operation; retrying later is meaningless |

**Common characteristics:**
- Requires **runtime context** (WebSocket, memory buffer)
- **Real-time** response expected
- Context is **not serializable** or **lost on restart**

### Alternative Solutions for Non-Suitable Cases

**Buffer flush (`worker-output-file.ts`):**
- Consider synchronous flush on critical paths
- Or: Write-ahead logging before buffering

**WebSocket handlers (`routes.ts`, `git-diff-handler.ts`):**
- Implement in-process retry with circuit breaker
- Client-side reconnection with state recovery

## Technology

- **SQLite**: Persistence via `bun:sqlite` (zero external dependencies)
- **Kysely**: Type-safe SQL queries (see [SQLite Migration Design](./sqlite-migration-design.md) for details)
- **Auto-migration**: On startup with automatic backup

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Server                                                          │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ JobQueue                                                    │ │
│ │ ├── SQLite (data.db)         ← Persistence                  │ │
│ │ ├── EventEmitter             ← Event-driven processing      │ │
│ │ ├── Worker Pool              ← Concurrency control          │ │
│ │ └── Retry Scheduler          ← Backoff timer management     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Job Handlers (registered per job type)                      │ │
│ │ ├── "cleanup:session-outputs" → DeleteSessionOutputs        │ │
│ │ ├── "cleanup:worker-output"   → DeleteWorkerOutput          │ │
│ │ ├── "cleanup:repository"      → CleanupRepositoryData       │ │
│ │ └── ...                                                     │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Client                                                          │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Job Management UI                                           │ │
│ │ ├── Job list (filterable by status)                         │ │
│ │ ├── Job details (payload, error, attempts)                  │ │
│ │ └── Actions (retry stalled, cancel)                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Job Lifecycle

```
                    ┌──────────────────────────────────────┐
                    ↓                                      │
enqueue() → [pending] → [processing] → [completed] ✓      │
                             │                             │
                             ↓ (failure)                   │
                        attempts < max?                    │
                         ↙        ↘                        │
                       yes         no                      │
                        ↓           ↓                      │
                 (backoff wait)  [stalled] ✗              │
                        │           ↓                      │
                        │      manual retry ───────────────┘
                        │
                        └──────────────────────────────────┘
```

### Status Definitions

| Status | Description |
|--------|-------------|
| `pending` | Waiting to be processed (includes retry-waiting jobs) |
| `processing` | Currently being executed |
| `completed` | Successfully finished |
| `stalled` | Max attempts reached, requires manual intervention |

## Database Schema

```sql
-- Added to: ~/.agent-console/data.db (after SQLite migration)

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,              -- JSON string
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at INTEGER NOT NULL,     -- Unix timestamp (ms)
  last_error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

-- For fetching next job to process
CREATE INDEX idx_jobs_pending ON jobs(status, priority DESC, next_retry_at);

-- For management UI filtering
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);
```

## Core Implementation

### JobQueue Class

```typescript
// packages/server/src/jobs/JobQueue.ts

import { Database } from 'bun:sqlite'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

type JobHandler<T = unknown> = (payload: T) => Promise<void>

interface JobRecord {
  id: string
  type: string
  payload: string
  status: 'pending' | 'processing' | 'completed' | 'stalled'
  priority: number
  attempts: number
  max_attempts: number
  next_retry_at: number
  last_error: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
}

interface EnqueueOptions {
  priority?: number      // Higher = processed first (default: 0)
  maxAttempts?: number   // Default: 5
}

export class JobQueue {
  private db: Database
  private handlers = new Map<string, JobHandler>()
  private emitter = new EventEmitter()
  private processing = 0
  private concurrency: number
  private retryTimers = new Map<string, Timer>()

  // Retry configuration
  private readonly backoffBase = 1000       // 1 second
  private readonly backoffMax = 5 * 60_000  // 5 minutes max

  constructor(dbPath: string, options?: { concurrency?: number }) {
    this.db = new Database(dbPath)
    this.concurrency = options?.concurrency ?? 4
    this.initSchema()
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_retry_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )
    `)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, priority DESC, next_retry_at)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type)`)
  }

  // --- Public API ---

  registerHandler<T>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler)
  }

  enqueue(type: string, payload: unknown, options?: EnqueueOptions): string {
    const id = randomUUID()
    const now = Date.now()

    this.db.run(`
      INSERT INTO jobs (id, type, payload, priority, max_attempts, next_retry_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      type,
      JSON.stringify(payload),
      options?.priority ?? 0,
      options?.maxAttempts ?? 5,
      now,
      now
    ])

    this.emitter.emit('job:added')
    return id
  }

  async start(): Promise<void> {
    // Recover jobs that were processing when server crashed
    this.db.run(`
      UPDATE jobs
      SET status = 'pending', next_retry_at = ?
      WHERE status = 'processing'
    `, [Date.now()])

    // Set up event listeners
    this.emitter.on('job:added', () => this.tryProcess())
    this.emitter.on('job:completed', () => this.tryProcess())

    // Schedule retries for pending jobs with future next_retry_at
    this.scheduleAllRetries()

    // Start processing immediately available jobs
    this.tryProcess()
  }

  async stop(): Promise<void> {
    // Clear all retry timers
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.emitter.removeAllListeners()
  }

  // --- Management API (for UI) ---

  getJobs(options?: { status?: string; type?: string; limit?: number; offset?: number }): JobRecord[] {
    let sql = 'SELECT * FROM jobs WHERE 1=1'
    const params: unknown[] = []

    if (options?.status) {
      sql += ' AND status = ?'
      params.push(options.status)
    }
    if (options?.type) {
      sql += ' AND type = ?'
      params.push(options.type)
    }

    sql += ' ORDER BY created_at DESC'

    if (options?.limit) {
      sql += ' LIMIT ?'
      params.push(options.limit)
    }
    if (options?.offset) {
      sql += ' OFFSET ?'
      params.push(options.offset)
    }

    return this.db.query(sql).all(...params) as JobRecord[]
  }

  getJob(id: string): JobRecord | null {
    return this.db.query('SELECT * FROM jobs WHERE id = ?').get(id) as JobRecord | null
  }

  getStats(): { pending: number; processing: number; completed: number; stalled: number } {
    const result = this.db.query(`
      SELECT status, COUNT(*) as count FROM jobs GROUP BY status
    `).all() as { status: string; count: number }[]

    const stats = { pending: 0, processing: 0, completed: 0, stalled: 0 }
    for (const row of result) {
      stats[row.status as keyof typeof stats] = row.count
    }
    return stats
  }

  retryJob(id: string): boolean {
    const result = this.db.run(`
      UPDATE jobs
      SET status = 'pending', attempts = 0, next_retry_at = ?, last_error = NULL
      WHERE id = ? AND status = 'stalled'
    `, [Date.now(), id])

    if (result.changes > 0) {
      this.emitter.emit('job:added')
      return true
    }
    return false
  }

  cancelJob(id: string): boolean {
    const result = this.db.run(`
      DELETE FROM jobs WHERE id = ? AND status IN ('pending', 'stalled')
    `, [id])
    return result.changes > 0
  }

  // --- Internal ---

  private tryProcess(): void {
    while (this.processing < this.concurrency) {
      const job = this.claimNextJob()
      if (!job) break

      this.processing++
      this.processJob(job)
        .finally(() => {
          this.processing--
          this.emitter.emit('job:completed')
        })
    }
  }

  private claimNextJob(): JobRecord | null {
    const now = Date.now()

    // Find and claim the next available job atomically
    const job = this.db.query(`
      SELECT * FROM jobs
      WHERE status = 'pending' AND next_retry_at <= ?
      ORDER BY priority DESC, next_retry_at ASC
      LIMIT 1
    `).get(now) as JobRecord | null

    if (!job) return null

    const result = this.db.run(`
      UPDATE jobs
      SET status = 'processing', started_at = ?
      WHERE id = ? AND status = 'pending'
    `, [now, job.id])

    if (result.changes === 0) return null  // Another worker claimed it

    return { ...job, status: 'processing', started_at: now }
  }

  private async processJob(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type)

    if (!handler) {
      this.handleFailure(job, new Error(`No handler registered for job type: ${job.type}`))
      return
    }

    try {
      const payload = JSON.parse(job.payload)
      await handler(payload)
      this.markCompleted(job.id)
    } catch (error) {
      this.handleFailure(job, error instanceof Error ? error : new Error(String(error)))
    }
  }

  private markCompleted(id: string): void {
    this.db.run(`
      UPDATE jobs
      SET status = 'completed', completed_at = ?
      WHERE id = ?
    `, [Date.now(), id])
  }

  private handleFailure(job: JobRecord, error: Error): void {
    const attempts = job.attempts + 1
    const now = Date.now()

    if (attempts >= job.max_attempts) {
      // Max attempts reached - mark as stalled
      this.db.run(`
        UPDATE jobs
        SET status = 'stalled', attempts = ?, last_error = ?
        WHERE id = ?
      `, [attempts, error.message, job.id])
    } else {
      // Schedule retry with exponential backoff
      const backoff = this.calculateBackoff(attempts)
      const nextRetryAt = now + backoff

      this.db.run(`
        UPDATE jobs
        SET status = 'pending', attempts = ?, next_retry_at = ?, last_error = ?
        WHERE id = ?
      `, [attempts, nextRetryAt, error.message, job.id])

      this.scheduleRetry(job.id, backoff)
    }
  }

  private calculateBackoff(attempts: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to max
    const backoff = this.backoffBase * Math.pow(2, attempts - 1)
    return Math.min(backoff, this.backoffMax)
  }

  private scheduleRetry(jobId: string, delay: number): void {
    // Clear existing timer if any
    const existing = this.retryTimers.get(jobId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.retryTimers.delete(jobId)
      this.emitter.emit('job:added')
    }, delay)

    this.retryTimers.set(jobId, timer)
  }

  private scheduleAllRetries(): void {
    const now = Date.now()
    const pendingJobs = this.db.query(`
      SELECT id, next_retry_at FROM jobs
      WHERE status = 'pending' AND next_retry_at > ?
    `).all(now) as { id: string; next_retry_at: number }[]

    for (const job of pendingJobs) {
      this.scheduleRetry(job.id, job.next_retry_at - now)
    }
  }
}
```

### Integration with Server

```typescript
// packages/server/src/index.ts

import { JobQueue } from './jobs/JobQueue'
import { workerOutputFileManager } from './lib/worker-output-file'

const jobQueue = new JobQueue(
  path.join(getConfigDir(), 'data.db'),  // Uses existing SQLite database
  { concurrency: 4 }
)

// Register handlers for cleanup operations
jobQueue.registerHandler<{ sessionId: string }>(
  'cleanup:session-outputs',
  async ({ sessionId }) => {
    await workerOutputFileManager.deleteSessionOutputs(sessionId)
  }
)

jobQueue.registerHandler<{ sessionId: string; workerId: string }>(
  'cleanup:worker-output',
  async ({ sessionId, workerId }) => {
    await workerOutputFileManager.deleteWorkerOutput(sessionId, workerId)
  }
)

jobQueue.registerHandler<{ repoPath: string }>(
  'cleanup:repository',
  async ({ repoPath }) => {
    // Cleanup repository worktrees directory
    const orgRepo = await getOrgRepoFromPath(repoPath)
    const repoDir = getRepositoryDir(orgRepo)
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true })
    }
  }
)

// Start processing
await jobQueue.start()

// Make available to routes
app.use('*', async (c, next) => {
  c.set('jobQueue', jobQueue)
  await next()
})
```

### Usage in Session Manager

```typescript
// Before (fire-and-forget)
void workerOutputFileManager.deleteSessionOutputs(sessionId).catch((err) => {
  logger.error({ sessionId, err }, 'Failed to delete session output files')
})

// After (guaranteed delivery)
jobQueue.enqueue('cleanup:session-outputs', { sessionId })
```

## REST API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs` | List jobs with filtering |
| GET | `/api/jobs/:id` | Get job details |
| GET | `/api/jobs/stats` | Get job statistics |
| POST | `/api/jobs/:id/retry` | Retry a stalled job |
| DELETE | `/api/jobs/:id` | Cancel a pending/stalled job |

### Response Examples

```typescript
// GET /api/jobs?status=stalled&limit=10
{
  "jobs": [
    {
      "id": "uuid",
      "type": "sync:worktree",
      "payload": { ... },
      "status": "stalled",
      "attempts": 5,
      "maxAttempts": 5,
      "lastError": "Connection refused",
      "createdAt": 1234567890
    }
  ],
  "total": 3
}

// GET /api/jobs/stats
{
  "pending": 5,
  "processing": 2,
  "completed": 150,
  "stalled": 3
}
```

## Management UI

### Job List Page (`/jobs`)

```
┌─────────────────────────────────────────────────────────────────┐
│ Jobs                                              [Refresh]     │
├─────────────────────────────────────────────────────────────────┤
│ Status: [All ▾] [Pending] [Processing] [Completed] [Stalled]   │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ⚠ sync:worktree              stalled    5/5    2 min ago   │ │
│ │   Connection refused                           [Retry]     │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ ⏳ notify:webhook            pending    0/5    1 min ago   │ │
│ │   Waiting for retry (next: 30s)                            │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ ✓ sync:worktree              completed  1/5    5 min ago   │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Job Detail Modal

```
┌─────────────────────────────────────────────────────────────────┐
│ Job Details                                              [×]    │
├─────────────────────────────────────────────────────────────────┤
│ ID:       abc123-def456-...                                     │
│ Type:     sync:worktree                                         │
│ Status:   stalled                                               │
│ Attempts: 5 / 5                                                 │
│ Created:  2024-01-15 10:30:00                                   │
│                                                                 │
│ Payload:                                                        │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ {                                                           │ │
│ │   "sessionId": "session-123",                               │ │
│ │   "path": "/path/to/worktree"                               │ │
│ │ }                                                           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ Last Error:                                                     │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ECONNREFUSED: Connection refused at 127.0.0.1:8080          │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│                              [Cancel Job]  [Retry Job]          │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration Options

```typescript
interface JobQueueConfig {
  // Processing
  concurrency: number        // Default: 4

  // Retry behavior
  maxAttempts: number        // Default: 5 (can override per job)
  backoffBase: number        // Default: 1000 (1 second)
  backoffMax: number         // Default: 300000 (5 minutes)

  // Cleanup (optional future feature)
  completedRetention: number // How long to keep completed jobs (ms)
}
```

## Future Considerations

### Job Queue Enhancements
1. **Job cleanup**: Automatically delete completed jobs after a retention period
2. **Job dependencies**: Allow jobs to depend on other jobs completing first
3. **Scheduled jobs**: Add `scheduledAt` for delayed execution
4. **Job progress**: Support progress reporting for long-running jobs
5. **WebSocket notifications**: Real-time UI updates when job status changes
6. **Bulk operations**: Retry all stalled, cancel all pending of type X

### Prerequisite: SQLite Migration

This job queue feature should be implemented **after** the [SQLite Migration](./sqlite-migration-design.md) is complete. Benefits of this order:

- Kysely and SQLite infrastructure already in place
- Repository pattern established; JobQueue follows the same architecture
- Jobs table added directly to `data.db` (no separate `jobs.db` file needed)
- Cleaner implementation without legacy JSON code to work around

## Implementation Plan

### Phase 1: Core (MVP)
1. JobQueue class with SQLite persistence
2. Event-driven processing
3. Exponential backoff retry
4. Basic REST API

### Phase 2: Management UI
1. Job list page with filtering
2. Job detail view
3. Retry/cancel actions

### Phase 3: Polish
1. WebSocket notifications for real-time updates
2. Job statistics dashboard
3. Completed job cleanup

---

## Detailed Implementation Guide

This section provides specific guidance for implementing the job queue, including exact file locations, code changes, and testing requirements.

### Existing Code Analysis

#### Fire-and-Forget Patterns to Replace

| Location | Context | Current Code |
|----------|---------|--------------|
| `session-manager.ts` → `deleteOrphanSessions()` | Orphan session cleanup (server startup) | `void workerOutputFileManager.deleteSessionOutputs(sessionId).catch(...)` |
| `session-manager.ts` → `deleteSession()` | User deletes session | `void workerOutputFileManager.deleteSessionOutputs(id).catch(...)` |
| `session-manager.ts` → `removeAgentWorker()` | User deletes agent worker | `void workerOutputFileManager.deleteWorkerOutput(sessionId, workerId).catch(...)` |
| `session-manager.ts` → `removeTerminalWorker()` | User deletes terminal worker | `void workerOutputFileManager.deleteWorkerOutput(sessionId, workerId).catch(...)` |
| `repository-manager.ts` → `cleanupRepositoryData()` | User unregisters repository | `fs.rmSync(repoDir, { recursive: true })` in try/catch |

#### Relevant Existing Files

```
packages/server/src/
├── index.ts                      # Server entry point - add JobQueue initialization
├── routes/
│   └── api.ts                    # API routes - add /api/jobs endpoints
├── services/
│   ├── session-manager.ts        # 4 fire-and-forget patterns to replace
│   ├── repository-manager.ts     # 1 fire-and-forget pattern to replace
│   └── persistence-service.ts    # Reference for file persistence patterns
├── lib/
│   ├── worker-output-file.ts     # deleteSessionOutputs, deleteWorkerOutput methods
│   ├── config.ts                 # getConfigDir() for database path
│   └── logger.ts                 # createLogger() for logging
└── __tests__/
    └── utils/
        └── mock-fs-helper.ts     # setupTestConfigDir for tests
```

#### SessionManager Constructor

```typescript
// Current signature (packages/server/src/services/session-manager.ts:143-146)
constructor(
  ptyProvider: PtyProvider = bunPtyProvider,
  pathExists: (path: string) => Promise<boolean> = defaultPathExists
)
```

JobQueue will be injected as a third parameter with a default of `null` for backward compatibility.

### Implementation Checklist

#### Step 1: Create JobQueue Class

- [ ] Create `packages/server/src/jobs/` directory
- [ ] Create `packages/server/src/jobs/JobQueue.ts`
  - Implement the class as specified in this document
  - Use `bun:sqlite` for database operations
  - Use `EventEmitter` for event-driven processing
- [ ] Create `packages/server/src/jobs/index.ts` (exports)

#### Step 2: Add JobQueue Tests

- [ ] Create `packages/server/src/jobs/__tests__/JobQueue.test.ts`
- [ ] Test cases:
  - `enqueue()` adds job to database with correct status
  - `start()` processes pending jobs
  - `start()` recovers processing jobs after restart
  - Failed job retries with exponential backoff
  - Job marked as `stalled` after max attempts
  - `retryJob()` resets stalled job to pending
  - `cancelJob()` removes pending/stalled jobs
  - `getStats()` returns correct counts
- [ ] Use `setupTestConfigDir()` from `mock-fs-helper.ts` for test isolation

#### Step 3: Integrate with Server

- [ ] Modify `packages/server/src/index.ts`:
  ```typescript
  import { JobQueue } from './jobs/JobQueue.js'
  import { getConfigDir } from './lib/config.js'
  import path from 'path'

  // Initialize job queue
  const jobQueue = new JobQueue(
    path.join(getConfigDir(), 'data.db'),  // Uses existing SQLite database
    { concurrency: 4 }
  )

  // Register handlers
  jobQueue.registerHandler('cleanup:session-outputs', async ({ sessionId }) => {
    await workerOutputFileManager.deleteSessionOutputs(sessionId)
  })

  jobQueue.registerHandler('cleanup:worker-output', async ({ sessionId, workerId }) => {
    await workerOutputFileManager.deleteWorkerOutput(sessionId, workerId)
  })

  jobQueue.registerHandler('cleanup:repository', async ({ repoDir }) => {
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true })
    }
  })

  // Start processing
  await jobQueue.start()

  // Export for use in other modules
  export { jobQueue }
  ```

#### Step 4: Modify SessionManager

- [ ] Add optional JobQueue parameter to constructor:
  ```typescript
  constructor(
    ptyProvider: PtyProvider = bunPtyProvider,
    pathExists: (path: string) => Promise<boolean> = defaultPathExists,
    private jobQueue: JobQueue | null = null  // Add this
  )
  ```

- [ ] Replace fire-and-forget in `deleteOrphanSessions()`:
  ```typescript
  // Before
  void workerOutputFileManager.deleteSessionOutputs(sessionId).catch((err) => {
    logger.error({ sessionId, err }, 'Failed to delete orphan session output files');
  });

  // After
  if (this.jobQueue) {
    this.jobQueue.enqueue('cleanup:session-outputs', { sessionId });
  } else {
    void workerOutputFileManager.deleteSessionOutputs(sessionId).catch((err) => {
      logger.error({ sessionId, err }, 'Failed to delete orphan session output files');
    });
  }
  ```

- [ ] Replace fire-and-forget in `deleteSession()` (same pattern)

- [ ] Replace fire-and-forget in `removeAgentWorker()`:
  ```typescript
  // Before
  void workerOutputFileManager.deleteWorkerOutput(sessionId, workerId).catch((err) => {
    logger.error({ sessionId, workerId, err }, 'Failed to delete worker output file');
  });

  // After
  if (this.jobQueue) {
    this.jobQueue.enqueue('cleanup:worker-output', { sessionId, workerId });
  } else {
    void workerOutputFileManager.deleteWorkerOutput(sessionId, workerId).catch((err) => {
      logger.error({ sessionId, workerId, err }, 'Failed to delete worker output file');
    });
  }
  ```

- [ ] Replace fire-and-forget in `removeTerminalWorker()` (same pattern as above)

#### Step 5: Modify RepositoryManager

- [ ] Add optional JobQueue parameter to constructor
- [ ] Replace cleanup in `cleanupRepositoryData()`:
  ```typescript
  // Before
  private async cleanupRepositoryData(repoPath: string): Promise<void> {
    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);
    if (fs.existsSync(repoDir)) {
      try {
        fs.rmSync(repoDir, { recursive: true });
      } catch (e) {
        console.error(`Failed to clean up repository data: ${repoDir}`, e);
      }
    }
  }

  // After
  private async cleanupRepositoryData(repoPath: string): Promise<void> {
    const orgRepo = await getOrgRepoFromPath(repoPath);
    const repoDir = getRepositoryDir(orgRepo);
    if (this.jobQueue) {
      this.jobQueue.enqueue('cleanup:repository', { repoDir });
    } else if (fs.existsSync(repoDir)) {
      try {
        fs.rmSync(repoDir, { recursive: true });
      } catch (e) {
        console.error(`Failed to clean up repository data: ${repoDir}`, e);
      }
    }
  }
  ```

#### Step 6: Update Singleton Exports

- [ ] Modify `packages/server/src/services/session-manager.ts` export:
  ```typescript
  // At bottom of file, update singleton creation
  // Will need to pass jobQueue after it's initialized in index.ts
  // Option A: Lazy initialization
  // Option B: Factory function
  // Option C: Setter method
  ```

  **Recommended: Option C (Setter method)**
  ```typescript
  export class SessionManager {
    // ...
    setJobQueue(jobQueue: JobQueue): void {
      this.jobQueue = jobQueue;
    }
  }

  export const sessionManager = new SessionManager();
  ```

  Then in `index.ts`:
  ```typescript
  import { sessionManager } from './services/session-manager.js';
  sessionManager.setJobQueue(jobQueue);
  ```

#### Step 7: Add REST API Endpoints

- [ ] Add to `packages/server/src/routes/api.ts`:
  ```typescript
  import { jobQueue } from '../index.js';

  // GET /api/jobs - List jobs with filtering
  api.get('/jobs', (c) => {
    const status = c.req.query('status');
    const type = c.req.query('type');
    const limit = Number(c.req.query('limit')) || 50;
    const offset = Number(c.req.query('offset')) || 0;

    const jobs = jobQueue.getJobs({ status, type, limit, offset });
    return c.json({ jobs, total: jobs.length });
  });

  // GET /api/jobs/stats - Get statistics
  api.get('/jobs/stats', (c) => {
    const stats = jobQueue.getStats();
    return c.json(stats);
  });

  // GET /api/jobs/:id - Get single job
  api.get('/jobs/:id', (c) => {
    const job = jobQueue.getJob(c.req.param('id'));
    if (!job) throw new NotFoundError('Job');
    return c.json(job);
  });

  // POST /api/jobs/:id/retry - Retry stalled job
  api.post('/jobs/:id/retry', (c) => {
    const success = jobQueue.retryJob(c.req.param('id'));
    if (!success) throw new NotFoundError('Job');
    return c.json({ success: true });
  });

  // DELETE /api/jobs/:id - Cancel job
  api.delete('/jobs/:id', (c) => {
    const success = jobQueue.cancelJob(c.req.param('id'));
    if (!success) throw new NotFoundError('Job');
    return c.json({ success: true });
  });
  ```

#### Step 8: Add API Tests

- [ ] Add to `packages/server/src/__tests__/api.test.ts` or create new file:
  - Test GET /api/jobs returns job list
  - Test GET /api/jobs?status=stalled filters correctly
  - Test GET /api/jobs/stats returns counts
  - Test POST /api/jobs/:id/retry resets stalled job
  - Test DELETE /api/jobs/:id removes job

### Completion Criteria

- [ ] All 5 fire-and-forget patterns replaced with `jobQueue.enqueue()`
- [ ] JobQueue starts automatically on server startup
- [ ] Jobs persist across server restarts
- [ ] Failed jobs retry with exponential backoff (1s, 2s, 4s, 8s, ...)
- [ ] Jobs marked as `stalled` after 5 failures
- [ ] REST API endpoints functional
- [ ] All existing tests pass (`bun run test`)
- [ ] New tests for JobQueue class pass
- [ ] Manual verification:
  - Delete a session → job appears in `/api/jobs`
  - Restart server → pending jobs resume processing
  - Simulate failure → job retries with backoff
  - After 5 failures → job status is `stalled`
  - POST /api/jobs/:id/retry → job reprocesses

### Testing Strategy

#### Unit Tests (JobQueue.test.ts)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JobQueue } from '../JobQueue.js';
import { setupTestConfigDir, cleanupTestConfigDir } from '../../__tests__/utils/mock-fs-helper.js';
import path from 'path';

describe('JobQueue', () => {
  let jobQueue: JobQueue;
  const TEST_CONFIG_DIR = '/test/config';

  beforeEach(() => {
    setupTestConfigDir(TEST_CONFIG_DIR);
    jobQueue = new JobQueue(path.join(TEST_CONFIG_DIR, 'jobs.db'));
  });

  afterEach(async () => {
    await jobQueue.stop();
    cleanupTestConfigDir();
  });

  describe('enqueue', () => {
    it('should add job with pending status', () => {
      const id = jobQueue.enqueue('test:job', { foo: 'bar' });
      const job = jobQueue.getJob(id);

      expect(job).not.toBeNull();
      expect(job?.status).toBe('pending');
      expect(job?.type).toBe('test:job');
      expect(JSON.parse(job?.payload || '{}')).toEqual({ foo: 'bar' });
    });
  });

  describe('processing', () => {
    it('should process pending jobs', async () => {
      let processed = false;
      jobQueue.registerHandler('test:job', async () => {
        processed = true;
      });

      jobQueue.enqueue('test:job', {});
      await jobQueue.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(processed).toBe(true);
    });
  });

  // ... more tests
});
```

#### Integration Tests

Test that SessionManager correctly enqueues jobs when deleting sessions/workers.

### Notes for Implementers

1. **Database Location**: Use `path.join(getConfigDir(), 'data.db')` - the existing SQLite database from SQLite migration
2. **Backward Compatibility**: Keep fallback to fire-and-forget when `jobQueue` is null (for tests that don't need it)
3. **Circular Dependency**: Be careful with imports between `index.ts`, `session-manager.ts`, and `JobQueue.ts`. Use setter injection to avoid issues.
4. **Concurrency**: Default concurrency of 4 is reasonable; cleanup jobs are I/O bound, not CPU bound
5. **Error Messages**: Preserve existing error log messages in job handlers for debugging
