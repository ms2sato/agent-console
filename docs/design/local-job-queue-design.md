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
| `session-manager.ts:335-337` | Delete orphan session outputs | Idempotent file deletion, survives restart |
| `session-manager.ts:439-441` | Delete session outputs on user delete | Idempotent file deletion, survives restart |
| `session-manager.ts:601-603` | Delete agent worker output | Idempotent file deletion, survives restart |
| `session-manager.ts:607-609` | Delete terminal worker output | Idempotent file deletion, survives restart |
| `repository-manager.ts:103-115` | Cleanup repository data on unregister | Idempotent directory deletion, survives restart |

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

## Technology Choices

### Query Builder: Kysely

Use [Kysely](https://kysely.dev/) for type-safe SQL queries.

**Why Kysely:**
- Zero dependencies, lightweight
- Type-safe at query construction time (not just results)
- SQL-like syntax (low learning curve)
- Works with bun:sqlite

```typescript
import { Kysely, SqliteDialect } from 'kysely'
import { Database as BunDatabase } from 'bun:sqlite'

interface Database {
  jobs: {
    id: string
    type: string
    status: 'pending' | 'processing' | 'completed' | 'stalled'
    payload: string
    attempts: number
    // ...
  }
}

const db = new Kysely<Database>({
  dialect: new SqliteDialect({
    database: new BunDatabase('jobs.db'),
  }),
})

// Fully type-safe queries
const pendingJobs = await db
  .selectFrom('jobs')
  .where('status', '=', 'pending')  // Type error if invalid status
  .selectAll()
  .execute()
```

**Alternatives considered:**
- **Drizzle**: More ORM-like, heavier, type safety only on results
- **Raw bun:sqlite**: No type safety
- **Prisma**: Too heavy for this use case

### Migration Strategy

**Phase 1 (Job Queue only):** Simple `initSchema()` with `PRAGMA user_version`

```typescript
private initSchema(): void {
  const version = this.db.query('PRAGMA user_version').get()

  if (version.user_version === 0) {
    // Initial schema
    this.db.run(`CREATE TABLE IF NOT EXISTS jobs (...)`)
    this.db.run('PRAGMA user_version = 1')
  }

  // Future migrations
  if (version.user_version === 1) {
    this.db.run('ALTER TABLE jobs ADD COLUMN priority INTEGER DEFAULT 0')
    this.db.run('PRAGMA user_version = 2')
  }
}
```

**Phase 2+ (Multiple tables):** Consider [kysely-ctl](https://kysely.dev/) for migration management

```bash
# When schema changes become frequent
npx kysely migrate:latest
npx kysely migrate:down
```

### Migration Execution

**Auto-migrate on startup** with automatic backup:

```typescript
async function startServer() {
  const pending = await migrator.getPendingMigrations()

  if (pending.length > 0) {
    // Auto backup before migration
    const backupPath = `${dbPath}.backup-${Date.now()}`
    fs.copyFileSync(dbPath, backupPath)
    logger.info(`Database backed up to ${backupPath}`)

    // Apply migrations
    for (const migration of pending) {
      logger.info(`Applying migration: ${migration.name}`)
      await migrator.apply(migration)
    }
  }

  app.listen(3000)
}
```

**Rationale:**
- Local app → manual migration commands are inconvenient
- Auto backup → safe rollback if issues occur
- Logging → visibility into what changed

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Server                                                          │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ JobQueue                                                    │ │
│ │ ├── SQLite (jobs.db)         ← Persistence                  │ │
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
-- File: ~/.agent-console/jobs.db

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
  path.join(AGENT_CONSOLE_HOME, 'jobs.db'),
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

### SQLite Full Migration (Out of Scope)

Once the job queue is stable, consider migrating other persistence to SQLite:

| Current | Migration Target | Notes |
|---------|------------------|-------|
| `sessions.json` | `sessions` table | Resolves read-modify-write race conditions |
| `repositories.json` | `repositories` table | Same benefits |
| `agents.json` | `agents` table | Same benefits |
| `outputs/**/*.log` | Keep as files | Append-heavy, SQLite adds overhead |

**Benefits of unified SQLite storage:**
- Single database file (`~/.agent-console/data.db`)
- ACID transactions across all data
- WAL mode for concurrent access
- Simplified backup (single file)

**JSON → SQLite Migration Strategy:**

One-time migration on first startup after upgrade:

```typescript
async function migrateFromJson() {
  // Skip if already migrated
  const count = await db.selectFrom('sessions').select(countAll()).executeTakeFirst()
  if (count && count.count > 0) return

  // Migrate sessions.json → sessions table
  const sessionsPath = path.join(AGENT_CONSOLE_HOME, 'sessions.json')
  if (fs.existsSync(sessionsPath)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'))
    for (const session of sessions) {
      await db.insertInto('sessions').values(session).execute()
    }
    // Rename to indicate migration complete
    fs.renameSync(sessionsPath, `${sessionsPath}.migrated`)
    logger.info(`Migrated ${sessions.length} sessions from JSON to SQLite`)
  }

  // Repeat for repositories.json, agents.json...
}
```

This is a separate initiative and not part of the job queue implementation.

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
