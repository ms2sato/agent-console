# Dependency Injection Design (Server)

## Overview

Move the server from global singletons (e.g., `getDatabase()`, `getSessionManager()`) to explicit dependency injection. The immediate driver is test isolation for SQLite, but the design targets full DI across server modules to make future changes safer and reduce hidden coupling.

## Goals

- Eliminate global singletons for the database and other stateful services.
- Make dependencies explicit in constructors/factories and route wiring.
- Keep production behavior identical (same database file, same migrations, same startup flow).
- Improve test isolation without per-test schema hacks.

## Non-Goals

- Introducing a third-party DI container.
- Changing client behavior or API contracts.
- Changing database schema or migration logic.

## Current Issues (Verified)

- Global DB access via `getDatabase()` causes cross-test interference when tests run in parallel.
- Multiple services import `getDatabase()` directly.
- Verified scope: `rg -c "getDatabase" packages/server/src` reports 17 files referencing `getDatabase()`.

## Proposed Architecture

### AppContext

Introduce an `AppContext` that owns all stateful dependencies and is explicitly passed to routes/services/jobs.

```ts
type AppContext = {
  db: Kysely<Database>;
  jobQueue: JobQueue;
  sessionRepository: SessionRepository;
  sessionManager: SessionManager;
  repositoryManager: RepositoryManager;
  notificationManager: NotificationManager;
  inboundIntegration: InboundIntegration;
};
```

### Factory Functions

- `createAppContext()` for production boot:
  - `db = await initializeDatabase()`
  - construct job queue, repositories, managers, services
  - wire cross-dependencies explicitly
- `createTestContext()` for tests:
  - `db = await createDatabaseForTest(':memory:')`
  - same construction logic as production
  - optional overrides for test doubles

### Hono Integration

Attach the context to requests via Hono variables:

```ts
type AppBindings = {
  Variables: {
    appContext: AppContext;
  };
};

app.use('*', async (c, next) => {
  c.set('appContext', appContext);
  await next();
});
```

Routes use `c.get('appContext')` instead of global getters.

### Service and Repository Construction

Replace singleton getters with explicit constructors/factories:

- Repositories accept `db` in constructor.
- Services accept required repositories/queues/managers in constructor.
- Job queue is created with `new JobQueue(db, opts)`.
- Notification services receive repository adapters instead of importing DB directly.

## Migration Plan

1. **Introduce AppContext + factories**
   - Add `createAppContext()` and `createTestContext()`.
   - Keep existing singletons as transitional shims.
2. **Refactor job queue**
   - Replace `initializeJobQueue()` that reads `getDatabase()` with `createJobQueue(db, opts)`.
3. **Refactor repositories**
   - Ensure every repository takes `db` in constructor.
   - Remove direct `getDatabase()` usage from repository modules.
4. **Refactor services**
   - Move database access into repository instances.
   - Pass repositories/managers explicitly.
5. **Refactor routes/websocket handlers**
   - Fetch dependencies from `appContext` instead of global getters.
6. **Remove singletons**
   - Delete `getDatabase()` accessors and service singleton exports once all call sites are migrated.
7. **Tests**
   - Replace global `initializeDatabase()` in tests with `createTestContext()`.
   - Ensure all tests run under `bun run test` without isolated test files.

## Impact

Moderate-to-large refactor across server:

- Database access paths: 17 files currently import `getDatabase()` (verified via `rg`).
- Additional files will change to remove singleton getters for managers/services.

## Alternatives Considered

1. **Keep global DB and serialize tests**
   - Rejected: slows tests and keeps hidden coupling.
2. **Only inject DB in a few repositories**
   - Rejected: partial DI still leaves global access and flakiness.
3. **Introduce a DI container**
   - Rejected for now: extra complexity without clear benefit.

## Risks and Mitigations

- **Refactor risk**: many call sites. Mitigate with incremental migration and tests.
- **Context leakage**: ensure `AppContext` is only created in entrypoint and test helpers.
- **Startup ordering**: keep existing initialization order, but express it inside `createAppContext()`.

## Open Questions

- Should we keep transitional getters (e.g., `getSessionManager()`) during migration?
- Should `AppContext` be stored in a module-level variable for WebSocket handlers, or always passed explicitly?

