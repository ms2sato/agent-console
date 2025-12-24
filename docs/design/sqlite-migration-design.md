# SQLite Migration Design

## Overview

A phased approach to migrate the persistence layer from JSON files to SQLite, improving reliability, performance, and maintainability. This migration introduces a Repository pattern first, then swaps the implementation to SQLite.

## Background

The current persistence layer has several issues:

1. **Inefficient persistence**: Every single session update reloads and rewrites ALL sessions (O(n))
2. **Scattered persistence calls**: 6+ locations in SessionManager + direct calls from API routes
3. **Duplicated conversion logic**: `toPersistedSession()` and `restoreWorkersFromPersistence()`
4. **Lack of encapsulation**: API routes call `persistenceService` directly, bypassing SessionManager
5. **Race conditions**: Read-modify-write pattern without locking

This migration lays the groundwork for future features like the [Job Queue](./local-job-queue-design.md) that will also use SQLite.

## Goals

- **Separation of concerns**: Business logic (SessionManager) vs. persistence (Repository)
- **Testability**: Repository can be mocked; SessionManager can be unit tested
- **Flexibility**: Easy to swap implementations (JSON → SQLite)
- **Performance**: Efficient queries, no full-file rewrites
- **Type safety**: Kysely for compile-time SQL validation

## Migration Strategy: Repository Layer First

### Why Not "Direct to SQLite"?

| Approach | Risk | Rollback | PR Size |
|----------|------|----------|---------|
| Direct SQLite | High | Difficult | Large |
| Repository first | Low | Easy | Small × 2 |

Introducing the Repository layer first allows:
- Incremental changes with smaller PRs
- Immediate benefit (SessionManager cleanup) before SQLite
- Easy rollback if issues arise
- SQLite becomes an "implementation detail"

### Phase Overview

```
Phase 1: Repository Layer (JSON implementation)
├── Define SessionRepository interface
├── Implement JsonSessionRepository (wrap existing logic)
├── Refactor SessionManager to use Repository
└── Remove direct persistenceService calls from routes

Phase 2: SQLite Implementation
├── Implement SqliteSessionRepository
├── Add migration logic (JSON → SQLite)
└── Auto-detect: use SQLite if data.db exists

Phase 3: Extend to Other Data
├── RepositoryRepository, AgentRepository
├── Consolidate into single database file
└── Remove JSON files
```

## Phase 1: Repository Layer

### Interface Design

```typescript
// packages/server/src/repositories/session-repository.ts

interface SessionRepository {
  // Queries
  findAll(): Promise<PersistedSession[]>
  findById(id: string): Promise<PersistedSession | null>
  findByStatus(status: 'active' | 'inactive'): Promise<PersistedSession[]>
  findByServerPid(pid: number): Promise<PersistedSession[]>

  // Commands
  save(session: PersistedSession): Promise<void>
  delete(id: string): Promise<void>
}
```

### JSON Implementation (Wraps Existing Logic)

```typescript
// packages/server/src/repositories/json-session-repository.ts

class JsonSessionRepository implements SessionRepository {
  constructor(private filePath: string) {}

  async findAll(): Promise<PersistedSession[]> {
    // Move existing persistenceService.loadSessions() logic here
    return safeRead(this.filePath, [])
  }

  async save(session: PersistedSession): Promise<void> {
    const sessions = await this.findAll()
    const idx = sessions.findIndex(s => s.id === session.id)
    if (idx >= 0) {
      sessions[idx] = session
    } else {
      sessions.push(session)
    }
    atomicWrite(this.filePath, JSON.stringify(sessions, null, 2))
  }

  async delete(id: string): Promise<void> {
    const sessions = await this.findAll()
    const filtered = sessions.filter(s => s.id !== id)
    atomicWrite(this.filePath, JSON.stringify(filtered, null, 2))
  }

  // ... other methods
}
```

### SessionManager Refactoring

```typescript
// Before (scattered persistence calls)
class SessionManager {
  private persistSession(session: InternalSession): void {
    const sessions = persistenceService.loadSessions()
    // ... manual array manipulation
    persistenceService.saveSessions(sessions)
  }
}

// After (delegated to repository)
class SessionManager {
  constructor(private sessionRepository: SessionRepository) {}

  private async persistSession(session: InternalSession): Promise<void> {
    const persisted = this.toPersistedSession(session)
    await this.sessionRepository.save(persisted)
  }
}
```

### API Routes Refactoring

```typescript
// Before (direct persistence access)
app.delete('/api/sessions/:id', (c) => {
  persistenceService.removeSession(id)  // ← bypasses SessionManager
})

// After (through SessionManager)
app.delete('/api/sessions/:id', (c) => {
  await sessionManager.deleteSession(id)  // ← single entry point
})
```

## Phase 2: SQLite Implementation

### Technology Choice: Kysely

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
  sessions: {
    id: string
    type: 'worktree' | 'quick'
    location_path: string
    status: 'active' | 'inactive'
    server_pid: number | null
    created_at: number
    initial_prompt: string | null
    title: string | null
  }
  workers: {
    id: string
    session_id: string
    type: 'agent' | 'terminal' | 'git-diff'
    name: string
    // ...
  }
}

const db = new Kysely<Database>({
  dialect: new SqliteDialect({
    database: new BunDatabase(path.join(AGENT_CONSOLE_HOME, 'data.db')),
  }),
})
```

**Alternatives considered:**
- **Drizzle**: More ORM-like, heavier, type safety only on results
- **Raw bun:sqlite**: No type safety
- **Prisma**: Too heavy for this use case

### SQLite Repository Implementation

```typescript
// packages/server/src/repositories/sqlite-session-repository.ts

class SqliteSessionRepository implements SessionRepository {
  constructor(private db: Kysely<Database>) {}

  async findAll(): Promise<PersistedSession[]> {
    const sessions = await this.db
      .selectFrom('sessions')
      .selectAll()
      .execute()

    // Load workers for each session
    return Promise.all(sessions.map(s => this.hydrate(s)))
  }

  async findById(id: string): Promise<PersistedSession | null> {
    const session = await this.db
      .selectFrom('sessions')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst()

    return session ? this.hydrate(session) : null
  }

  async save(session: PersistedSession): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // Upsert session
      await trx
        .insertInto('sessions')
        .values(this.toRow(session))
        .onConflict(oc => oc.column('id').doUpdateSet(this.toRow(session)))
        .execute()

      // Replace workers
      await trx.deleteFrom('workers').where('session_id', '=', session.id).execute()
      for (const worker of session.workers) {
        await trx.insertInto('workers').values(this.workerToRow(worker)).execute()
      }
    })
  }

  // ...
}
```

### Migration Strategy

**Auto-migrate on startup** with automatic backup:

```typescript
async function initializeDatabase() {
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
}
```

**Schema versioning:**
- Simple approach: Use `PRAGMA user_version` for tracking schema version
- For complex migrations: Consider [kysely-ctl](https://kysely.dev/) for migration management

### JSON → SQLite Data Migration

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
      await db.insertInto('sessions').values(sessionToRow(session)).execute()
      for (const worker of session.workers) {
        await db.insertInto('workers').values(workerToRow(worker)).execute()
      }
    }
    // Rename to indicate migration complete
    fs.renameSync(sessionsPath, `${sessionsPath}.migrated`)
    logger.info(`Migrated ${sessions.length} sessions from JSON to SQLite`)
  }

  // Repeat for repositories.json, agents.json...
}
```

## Phase 3: Full Migration

### Target State

| Current | Migration Target | Notes |
|---------|------------------|-------|
| `sessions.json` | `sessions` + `workers` tables | Resolves read-modify-write race conditions |
| `repositories.json` | `repositories` table | Same benefits |
| `agents.json` | `agents` table | Same benefits |
| `outputs/**/*.log` | Keep as files | Append-heavy, SQLite adds overhead |

### Benefits of Unified SQLite Storage

- **Single database file**: `~/.agent-console/data.db`
- **ACID transactions**: Atomic operations across tables
- **Simplified backup**: Single file to backup
- **Query flexibility**: JOIN across sessions and workers

## Database Schema

```sql
-- File: ~/.agent-console/data.db

-- Sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('worktree', 'quick')),
  location_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  server_pid INTEGER,
  created_at INTEGER NOT NULL,
  initial_prompt TEXT,
  title TEXT,
  -- Worktree-specific
  repository_id TEXT,
  branch_name TEXT,
  worktree_path TEXT
);

-- Workers table
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('agent', 'terminal', 'git-diff')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pid INTEGER,
  -- Agent-specific
  agent_id TEXT,
  -- Git-diff-specific
  base_commit TEXT
);

CREATE INDEX idx_workers_session ON workers(session_id);

-- Repositories table
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  registered_at INTEGER NOT NULL
);

-- Agents table (custom agents only)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT,  -- JSON array
  cwd TEXT,
  activity_patterns TEXT,  -- JSON
  registered_at INTEGER NOT NULL
);
```

## Challenges and Considerations

### 1. Async Conversion

Current `persistSession()` is synchronous. Repository pattern typically uses async:

```typescript
// Need to convert these to async
private persistSession(session: InternalSession): void  // sync
private async persistSession(session: InternalSession): Promise<void>  // async
```

This requires updating callers to use `await`.

### 2. Lazy Activation Pattern

Current design: Load sessions without PTY, activate on WebSocket connection.

```typescript
interface InternalWorker {
  pty: PtyInstance | null  // null until WebSocket connects
}
```

Repository must understand this multi-stage initialization:
- `findAll()` returns sessions with `pty: null`
- SessionManager activates PTY when needed
- Repository doesn't care about PTY state (that's runtime only)

### 3. Dual State Consistency

Memory state (InternalSession) vs. persisted state (PersistedSession) can diverge:

```typescript
// Memory has runtime state
InternalSession.workers.get(id).pty  // PtyInstance
InternalSession.workers.get(id).outputBuffer  // string

// Persisted has snapshot
PersistedSession.workers[i].pid  // number | null (just the PID)
```

Repository only handles PersistedSession. SessionManager maintains consistency.

## Implementation Plan

### Phase 1: Repository Layer (Estimated: Small-Medium PR)
1. Define `SessionRepository` interface
2. Implement `JsonSessionRepository` (extract from persistenceService)
3. Refactor SessionManager to use Repository (inject via constructor)
4. Update API routes to go through SessionManager
5. Tests for Repository layer

### Phase 2: SQLite Implementation (Estimated: Medium PR)
1. Add Kysely dependency
2. Implement `SqliteSessionRepository`
3. Add database initialization and migrations
4. Implement JSON → SQLite migration
5. Auto-detect backend: if `data.db` exists, use SQLite; otherwise use JSON
6. Tests for SQLite Repository

### Phase 3: Extend to Other Data (Estimated: Small PRs)
1. `RepositoryRepository` (repositories.json → SQLite)
2. `AgentRepository` (agents.json → SQLite)
3. Remove JSON file support (breaking change, major version)

#### RepositoryRepository Interface

```typescript
// packages/server/src/repositories/repository-repository.ts

interface RepositoryRepository {
  findAll(): Promise<Repository[]>
  findById(id: string): Promise<Repository | null>
  findByPath(path: string): Promise<Repository | null>
  save(repository: Repository): Promise<void>
  delete(id: string): Promise<void>
}
```

#### AgentRepository Interface

```typescript
// packages/server/src/repositories/agent-repository.ts

interface AgentRepository {
  findAll(): Promise<AgentDefinition[]>
  findById(id: string): Promise<AgentDefinition | null>
  save(agent: AgentDefinition): Promise<void>
  delete(id: string): Promise<boolean>  // Returns false for built-in agents
}
```

## Future: Job Queue Integration

After completing this SQLite migration, the [Job Queue](./local-job-queue-design.md) feature can be implemented.

**Benefits of completing SQLite migration first:**
- Repository pattern established; JobQueue can follow the same architecture
- SQLite infrastructure (Kysely, migrations) already in place
- Jobs table can be added to existing `data.db` instead of separate file
- Cleaner implementation without legacy JSON code

**Job Queue implementation (future work):**
1. Add `jobs` table to database schema
2. Implement `JobQueue` class using existing SQLite infrastructure
3. Integrate with SessionManager for cleanup operations

---

## Detailed Implementation Guide: Phase 1

This section provides specific guidance for implementing the Repository Layer, including exact file locations, code changes, and testing requirements.

### Existing Code Analysis

#### Current `persistenceService` Usage

| File | Function | Usage | Action |
|------|----------|-------|--------|
| `session-manager.ts` | `initializeSessions()` | `loadSessions()` | Use Repository |
| `session-manager.ts` | `cleanupOrphanProcesses()` | `loadSessions()`, `saveSessions()` | Use Repository |
| `session-manager.ts` | `deleteOrphanSessions()` | `removeSession()` | Use Repository |
| `session-manager.ts` | `getSessionMetadata()` | wraps `persistenceService.getSessionMetadata()` | Use Repository |
| `session-manager.ts` | `deleteSession()` | `removeSession()` | Use Repository |
| `session-manager.ts` | `reconnectToWorker()` | `getSessionMetadata()` | Use Repository |
| `session-manager.ts` | `persistSession()` | `loadSessions()`, `saveSessions()` | Use Repository |
| `api.ts` | `DELETE /sessions/:id` | Direct `getSessionMetadata()`, `removeSession()` | **Go through SessionManager** |
| `api.ts` | `GET /health/debug` | `loadSessions()` | Go through SessionManager |
| `session-validation-service.ts` | `validateSessionExists()` | `loadSessions()` | Use Repository |
| `repository-manager.ts` | `loadFromDisk()`, `saveToDisk()` | `loadRepositories()`, `saveRepositories()` | Phase 3 |
| `agent-manager.ts` | various | `loadAgents()`, `saveAgents()` | Phase 3 |

#### The Problem with `persistSession()`

```typescript
// Current implementation (O(n) on every save)
private persistSession(session: InternalSession): void {
  const sessions = persistenceService.loadSessions();  // Load ALL
  const existingIdx = sessions.findIndex(s => s.id === session.id);
  // ... modify array
  persistenceService.saveSessions(sessions);  // Save ALL
}
```

With Repository:
```typescript
// New implementation (O(1))
private async persistSession(session: InternalSession): Promise<void> {
  const persisted = this.toPersistedSession(session);
  await this.sessionRepository.save(persisted);  // Save ONE
}
```

#### The Problem with Direct `persistenceService` Access in Routes

```typescript
// Current: api.ts bypasses SessionManager
api.delete('/sessions/:id', (c) => {
  // Try sessionManager first
  const deleted = sessionManager.deleteSession(sessionId);
  if (deleted) return c.json({ success: true });

  // Direct persistence access for orphaned sessions
  const metadata = persistenceService.getSessionMetadata(sessionId);  // ← PROBLEM
  persistenceService.removeSession(sessionId);  // ← PROBLEM
});
```

Solution: Add method to SessionManager that handles both cases.

### Relevant Existing Files

```
packages/server/src/
├── services/
│   ├── persistence-service.ts    # Current implementation (will be wrapped)
│   ├── session-manager.ts        # Main consumer - needs refactoring
│   ├── repository-manager.ts     # Phase 3 target
│   └── agent-manager.ts          # Phase 3 target
├── routes/
│   └── api.ts                    # Has direct persistenceService calls
├── repositories/                  # NEW DIRECTORY
│   ├── session-repository.ts     # Interface
│   └── json-session-repository.ts # Implementation
└── __tests__/
    └── utils/
        └── mock-fs-helper.ts     # For test isolation
```

### Implementation Checklist

#### Step 1: Create Repository Interface

- [ ] Create `packages/server/src/repositories/` directory
- [ ] Create `packages/server/src/repositories/session-repository.ts`:

```typescript
import type { PersistedSession } from '../services/persistence-service.js';

export interface SessionRepository {
  findAll(): Promise<PersistedSession[]>
  findById(id: string): Promise<PersistedSession | null>
  findByServerPid(pid: number): Promise<PersistedSession[]>
  save(session: PersistedSession): Promise<void>
  saveAll(sessions: PersistedSession[]): Promise<void>
  delete(id: string): Promise<void>
}
```

#### Step 2: Create JSON Implementation

- [ ] Create `packages/server/src/repositories/json-session-repository.ts`:

```typescript
import type { SessionRepository } from './session-repository.js';
import type { PersistedSession } from '../services/persistence-service.js';
// Reuse atomicWrite, safeRead from persistence-service or extract to shared util

export class JsonSessionRepository implements SessionRepository {
  constructor(private filePath: string) {}

  async findAll(): Promise<PersistedSession[]> {
    return safeRead(this.filePath, []);
  }

  async findById(id: string): Promise<PersistedSession | null> {
    const sessions = await this.findAll();
    return sessions.find(s => s.id === id) ?? null;
  }

  async findByServerPid(pid: number): Promise<PersistedSession[]> {
    const sessions = await this.findAll();
    return sessions.filter(s => s.serverPid === pid);
  }

  async save(session: PersistedSession): Promise<void> {
    const sessions = await this.findAll();
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    atomicWrite(this.filePath, JSON.stringify(sessions, null, 2));
  }

  async saveAll(sessions: PersistedSession[]): Promise<void> {
    atomicWrite(this.filePath, JSON.stringify(sessions, null, 2));
  }

  async delete(id: string): Promise<void> {
    const sessions = await this.findAll();
    const filtered = sessions.filter(s => s.id !== id);
    atomicWrite(this.filePath, JSON.stringify(filtered, null, 2));
  }
}
```

- [ ] Create `packages/server/src/repositories/index.ts` (exports)

#### Step 3: Refactor SessionManager

- [ ] Add SessionRepository parameter to constructor:

```typescript
import type { SessionRepository } from '../repositories/session-repository.js';
import { JsonSessionRepository } from '../repositories/json-session-repository.js';

export class SessionManager {
  private sessionRepository: SessionRepository;

  constructor(
    ptyProvider: PtyProvider = bunPtyProvider,
    pathExists: (path: string) => Promise<boolean> = defaultPathExists,
    sessionRepository?: SessionRepository  // Optional for backward compatibility
  ) {
    this.ptyProvider = ptyProvider;
    this.pathExists = pathExists;
    this.sessionRepository = sessionRepository ??
      new JsonSessionRepository(path.join(getConfigDir(), 'sessions.json'));

    // Note: initializeSessions needs to become async or use sync fallback
    this.initializeSessions();
    this.cleanupOrphanProcesses();
  }
```

- [ ] Convert `persistSession()` to async:

```typescript
// Before (sync)
private persistSession(session: InternalSession): void {
  const sessions = persistenceService.loadSessions();
  // ...
  persistenceService.saveSessions(sessions);
}

// After (async)
private async persistSession(session: InternalSession): Promise<void> {
  const persisted = this.toPersistedSession(session);
  await this.sessionRepository.save(persisted);
}
```

- [ ] Update all callers of `persistSession()` to use `await`:
  - `createSession()` - already async
  - `createWorker()` - already async
  - `activateWorkerPty()` - already async
  - `deleteWorker()` - make async
  - `restartAgentWorker()` - already async
  - `restoreWorker()` - already async
  - `updateSessionMetadata()` - already async

- [ ] Convert `initializeSessions()` to async with factory function pattern:

```typescript
// Factory function for async initialization
static async create(
  ptyProvider?: PtyProvider,
  pathExists?: (path: string) => Promise<boolean>,
  sessionRepository?: SessionRepository
): Promise<SessionManager> {
  const manager = new SessionManager(ptyProvider, pathExists, sessionRepository);
  await manager.initialize();
  return manager;
}

private async initialize(): Promise<void> {
  await this.initializeSessions();
  await this.cleanupOrphanProcesses();
}
```

Note: The constructor becomes private or should not call initialization methods. Callers must use `SessionManager.create()` instead of `new SessionManager()`.

- [ ] Replace all direct `persistenceService` calls with repository methods

#### Step 4: Add SessionManager Method for Orphaned Session Deletion

- [ ] Add method to handle both in-memory and persisted-only sessions:

```typescript
// In SessionManager
async forceDeleteSession(id: string): Promise<boolean> {
  // Try in-memory first
  if (this.deleteSession(id)) {
    return true;
  }

  // Check persistence for orphaned session
  const persisted = await this.sessionRepository.findById(id);
  if (persisted) {
    await this.sessionRepository.delete(id);
    return true;
  }

  return false;
}
```

#### Step 5: Update API Routes

- [ ] Modify `packages/server/src/routes/api.ts`:

```typescript
// Before (direct persistenceService access)
api.delete('/sessions/:id', (c) => {
  const deleted = sessionManager.deleteSession(sessionId);
  if (deleted) return c.json({ success: true });

  const metadata = persistenceService.getSessionMetadata(sessionId);
  if (!metadata) throw new NotFoundError('Session');
  persistenceService.removeSession(sessionId);
  return c.json({ success: true });
});

// After (through SessionManager)
api.delete('/sessions/:id', async (c) => {
  const deleted = await sessionManager.forceDeleteSession(sessionId);
  if (!deleted) throw new NotFoundError('Session');
  return c.json({ success: true });
});
```

- [ ] Remove `persistenceService` import from `api.ts` (after all usages removed)

#### Step 6: Update session-validation-service.ts

- [ ] Inject `SessionRepository` directly into `SessionValidationService`:

```typescript
// Before: Direct persistenceService access
export class SessionValidationService {
  async validateSessionExists(sessionId: string): Promise<PersistedSession> {
    const sessions = persistenceService.loadSessions();
    // ...
  }
}

// After: Repository injection
export class SessionValidationService {
  constructor(private sessionRepository: SessionRepository) {}

  async validateSessionExists(sessionId: string): Promise<PersistedSession> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new NotFoundError('Session');
    }
    return session;
  }
}
```

- [ ] Update instantiation in routes or create singleton with default repository

#### Step 7: Create Repository Tests

- [ ] Create `packages/server/src/repositories/__tests__/json-session-repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JsonSessionRepository } from '../json-session-repository.js';
import { setupTestConfigDir, cleanupTestConfigDir } from '../../__tests__/utils/mock-fs-helper.js';
import path from 'path';

describe('JsonSessionRepository', () => {
  const TEST_CONFIG_DIR = '/test/config';
  let repository: JsonSessionRepository;

  beforeEach(() => {
    setupTestConfigDir(TEST_CONFIG_DIR);
    repository = new JsonSessionRepository(
      path.join(TEST_CONFIG_DIR, 'sessions.json')
    );
  });

  afterEach(() => {
    cleanupTestConfigDir();
  });

  describe('findAll', () => {
    it('should return empty array when no sessions exist', async () => {
      const sessions = await repository.findAll();
      expect(sessions).toEqual([]);
    });
  });

  describe('save', () => {
    it('should save a new session', async () => {
      const session = createTestSession({ id: 'test-1' });
      await repository.save(session);

      const sessions = await repository.findAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('test-1');
    });

    it('should update existing session', async () => {
      const session = createTestSession({ id: 'test-1', title: 'Original' });
      await repository.save(session);

      const updated = { ...session, title: 'Updated' };
      await repository.save(updated);

      const sessions = await repository.findAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('should remove session by id', async () => {
      await repository.save(createTestSession({ id: 'test-1' }));
      await repository.save(createTestSession({ id: 'test-2' }));

      await repository.delete('test-1');

      const sessions = await repository.findAll();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('test-2');
    });
  });

  describe('findById', () => {
    it('should return session if exists', async () => {
      await repository.save(createTestSession({ id: 'test-1' }));

      const session = await repository.findById('test-1');
      expect(session?.id).toBe('test-1');
    });

    it('should return null if not exists', async () => {
      const session = await repository.findById('non-existent');
      expect(session).toBeNull();
    });
  });
});

function createTestSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: 'default-id',
    type: 'quick',
    locationPath: '/test/path',
    serverPid: process.pid,
    createdAt: new Date().toISOString(),
    workers: [],
    ...overrides,
  };
}
```

#### Step 8: Update Existing SessionManager Tests

- [ ] Update `session-manager.test.ts` to optionally inject mock repository
- [ ] Ensure existing tests still pass with default JsonSessionRepository

### Completion Criteria

- [ ] All `persistenceService` calls removed from `session-manager.ts`
- [ ] All `persistenceService` calls removed from `api.ts` (session-related)
- [ ] SessionRepository interface defined
- [ ] JsonSessionRepository implementation complete
- [ ] SessionManager uses injected repository
- [ ] New repository tests pass
- [ ] All existing SessionManager tests pass
- [ ] All existing API tests pass
- [ ] `bun run test` passes
- [ ] `bun run typecheck` passes

### Notes for Implementers

1. **Sync vs Async**: `JsonSessionRepository` methods are defined as `async` for interface consistency with future SQLite implementation, but internally use sync file operations. This is acceptable.

2. **Backward Compatibility**: Keep `persistenceService` for now - it's still used by `repository-manager.ts` and `agent-manager.ts` (Phase 3). Only remove session-related code paths.

3. **Migration Path**: After Phase 1, `persistenceService` will only contain repository/agent code. After Phase 3, it can be fully removed.

4. **Testing Strategy**: Inject mock repository in unit tests for isolation. Use real JsonSessionRepository in integration tests.

5. **Singleton Pattern**: The current `sessionManager` singleton export remains. Repository is injected via default parameter for production, explicit parameter for tests.
