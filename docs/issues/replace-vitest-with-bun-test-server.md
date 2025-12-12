# Plan: Replace vitest with bun test in server package

Related issue: [#44](https://github.com/ms2sato/agent-console/issues/44)

## Overview

Migrate `packages/server` from vitest to bun:test while refactoring tests to use low-level mocks instead of `vi.mock()`.

## Key Decisions

- **api.test.ts**: Introduce dependency injection to production code
- **MockPtyFactory**: Maintain existing pattern, adapt for bun:test without mock.module()
- **Testing guideline**: Use low-level mocks (fetch, fs, process) instead of module-level mocks
- **File System**: Use mock-fs library for in-memory file system mocking (no temp directories)
- **PTY**: Keep bun-pty for now, prepare for future Bun.Terminal migration (see Future Work)

## Future Work: Bun.Terminal Migration

When [PR #25415](https://github.com/oven-sh/bun/pull/25415) is merged and available in stable Bun:

1. Replace `bun-pty` with native `Bun.Terminal` API
2. Update `session-manager.ts` to use `Bun.spawn({ terminal: opts })`
3. Simplify test mocking (no external dependency to mock)

**API Comparison**:
| bun-pty | Bun.Terminal |
|---------|--------------|
| `spawn(cmd, args, opts)` | `Bun.spawn(cmd, { terminal: opts })` |
| `pty.onData(cb)` | `data` callback option |
| `pty.write(data)` | `proc.terminal.write(data)` |
| `pty.resize(cols, rows)` | `proc.terminal.resize(cols, rows)` |

**Preparation in this PR**: Design PTY abstraction layer to make future migration easier.

## Implementation Phases

### Phase 1: Infrastructure Setup

1. **Update package.json** (already done)
   - Change test scripts to `bun test src/`
   - Remove vitest dependency
   - Add `mock-fs` as devDependency

2. **Update mock-pty.ts**
   - File: `packages/server/src/__tests__/utils/mock-pty.ts`
   - Change: `import { vi } from 'vitest'` → `import { mock } from 'bun:test'`
   - Adapt `vi.fn()` → `mock()`

3. **Create mock-fs helper**
   - File: `packages/server/src/__tests__/utils/mock-fs-helper.ts`
   - Wrap mock-fs setup/teardown for consistent usage

### Phase 2: Simple Test Files (No vi.mock)

These files only need import changes:

| File | Changes |
|------|---------|
| `lib/__tests__/config.test.ts` | Import from bun:test |
| `lib/__tests__/error-handler.test.ts` | Import from bun:test |
| `lib/__tests__/errors.test.ts` | Import from bun:test |
| `lib/__tests__/server-config.test.ts` | Import from bun:test |
| `services/__tests__/activity-detector.test.ts` | Import from bun:test |
| `services/__tests__/env-filter.test.ts` | Import from bun:test |
| `services/__tests__/persistence-service.test.ts` | Import from bun:test |

### Phase 3: Service Tests with Persistence Mock

**Pattern**: Replace vi.mock for persistence-service with mock-fs (in-memory file system).

#### 3.1 agent-manager.test.ts
- **Current**: Mocks `persistence-service.js`
- **Solution**: Use real PersistenceService with mock-fs
- **Production change**: None (PersistenceService already supports AGENT_CONSOLE_HOME env var)

#### 3.2 repository-manager.test.ts
- **Current**: Mocks `persistence-service.js`, `config.js`
- **Solution**:
  - Use real PersistenceService with mock-fs
  - Set AGENT_CONSOLE_HOME env var for config
- **Production change**: None

#### 3.3 persistence-service.test.ts
- **Current**: Uses real fs with temp directories
- **Solution**: Migrate to mock-fs for consistency and speed
- **Production change**: None

### Phase 4: Command Execution Tests

#### 4.1 session-metadata-suggester.test.ts
- **Current**: Mocks `child_process.execSync`
- **Solution**: Create spy on execSync or use real commands with fixtures
- **Production change**: Add optional executor parameter for DI

#### 4.2 worktree-service.test.ts
- **Current**: Mocks `config.js`, `fs`, `child_process`
- **Solution**:
  - Use AGENT_CONSOLE_HOME for config
  - Use mock-fs for file system operations
  - Spy on child_process.execSync for git commands
- **Production change**: None

### Phase 5: Session Manager Tests (Complex)

#### 5.1 session-manager.test.ts
- **Current Mocks**: bun-pty, persistence-service, agent-manager, config, env-filter
- **Solution**:
  - **bun-pty**: Create PTY abstraction interface (DI) - prepares for Bun.Terminal migration
  - **persistence-service**: Real with mock-fs
  - **agent-manager**: Create with real persistence + mock-fs
  - **config**: AGENT_CONSOLE_HOME env var
  - **env-filter**: Real implementation
- **Production changes**:
  - Create `PtyProvider` interface abstraction
  - `SessionManager` constructor accepts optional `ptyProvider` parameter

```typescript
// lib/pty-provider.ts (new file)
export interface PtyInstance {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): { dispose: () => void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void };
}

export interface PtyProvider {
  spawn(command: string, args: string[], options: PtySpawnOptions): PtyInstance;
}

// Default implementation using bun-pty
export const bunPtyProvider: PtyProvider = {
  spawn: (cmd, args, opts) => spawn(cmd, args, opts)
};

// session-manager.ts
export class SessionManager {
  constructor(private ptyProvider: PtyProvider = bunPtyProvider) { ... }
}
```

This abstraction enables:
1. Easy mocking in tests without mock.module()
2. Future migration to Bun.Terminal by creating `bunTerminalProvider`

#### 5.2 session-manager-cleanup.test.ts
- **Current Mocks**: Same as above + process.kill
- **Solution**:
  - Same DI pattern as session-manager.test.ts
  - Mock process.kill at low level (global assignment)
  - Use mock-fs for persistence
- **Production changes**: Same as above

### Phase 6: API Integration Test (DI Required)

#### api.test.ts
- **Current Mocks**: All service managers (session, repository, worktree, agent, metadata-suggester), open, fs
- **Solution**: Dependency injection via factory function

**Production changes**:
```typescript
// routes/api.ts - Add factory function
export interface ApiDependencies {
  sessionManager: typeof sessionManager;
  repositoryManager: typeof repositoryManager;
  worktreeService: typeof worktreeService;
  agentManager: typeof agentManager;
}

export function createApiRouter(deps: ApiDependencies = {
  sessionManager,
  repositoryManager,
  worktreeService,
  agentManager
}): Hono { ... }
```

**Test approach**:
- Create mock service objects directly in test
- Pass to createApiRouter()
- No module mocking needed

### Phase 7: Worker Handler Test

#### worker-handler.test.ts
- **Current**: Mocks session-manager, fs
- **Solution**:
  - DI for session manager reference
  - Use mock-fs for image tests
- **Production change**: Accept sessionManager as parameter

## Files to Modify

### Production Code Changes
1. `packages/server/src/lib/pty-provider.ts` - **New file**: PTY abstraction interface
2. `packages/server/src/services/session-manager.ts` - Use PtyProvider DI
3. `packages/server/src/routes/api.ts` - Add createApiRouter factory
4. `packages/server/src/websocket/worker-handler.ts` - Add sessionManager DI

### New Test Utilities
1. `src/__tests__/utils/mock-fs-helper.ts` (new file)

### Test File Changes (all 15 files)
1. `src/__tests__/api.test.ts`
2. `src/__tests__/utils/mock-pty.ts`
3. `src/lib/__tests__/config.test.ts`
4. `src/lib/__tests__/error-handler.test.ts`
5. `src/lib/__tests__/errors.test.ts`
6. `src/lib/__tests__/server-config.test.ts`
7. `src/services/__tests__/activity-detector.test.ts`
8. `src/services/__tests__/agent-manager.test.ts`
9. `src/services/__tests__/env-filter.test.ts`
10. `src/services/__tests__/persistence-service.test.ts`
11. `src/services/__tests__/repository-manager.test.ts`
12. `src/services/__tests__/session-manager-cleanup.test.ts`
13. `src/services/__tests__/session-manager.test.ts`
14. `src/services/__tests__/session-metadata-suggester.test.ts`
15. `src/services/__tests__/worktree-service.test.ts`
16. `src/websocket/__tests__/worker-handler.test.ts`

## Implementation Order

1. Phase 1: Infrastructure (mock-pty.ts, mock-fs-helper.ts, package.json)
2. Phase 2: Simple tests (6 files - quick wins, excluding persistence-service.test.ts)
3. Phase 3: Persistence-dependent tests (3 files - including persistence-service.test.ts migration to mock-fs)
4. Phase 4: Command execution tests (2 files)
5. Phase 5: Session manager tests (2 files, requires production changes)
6. Phase 6: API test (1 file, requires production changes)
7. Phase 7: Worker handler test (1 file, requires production changes)

## Risk Mitigation

1. **Run tests after each phase** to catch regressions early
2. **Production changes are minimal** - only adding optional DI parameters
3. **Existing behavior preserved** - default parameters maintain backward compatibility
4. **Rollback plan**: Git revert if issues found

## Estimated Effort

- Phase 1-2: 30 minutes
- Phase 3-4: 1 hour
- Phase 5-7: 2-3 hours
- **Total**: 4-5 hours
