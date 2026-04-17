# Backend Standards (Procedural Detail)

> See [rules/backend.md](../../rules/backend.md) for the declarative rules (directory structure, file naming, async-over-sync requirement, resource cleanup checklist, security basics, structured logging). This document covers procedural detail, code patterns, and decision frameworks.

## Tech Stack

- **Bun** — JavaScript runtime
- **Hono** — web framework
- **bun-pty** — pseudo-terminal for spawning processes
- **Pino** — structured logging
- **Valibot** — schema validation (shared with frontend)

## Dependency Injection Policy

**Rule: no module-level singleton exports.** Services with state or external dependencies (DB, file system) must be instantiated in `createAppContext()` and injected where needed.

### Service Classification

| Classification | AppContext Registration | DI Method | Example |
|---------------|----------------------|-----------|---------|
| **First-class service** — used by route handlers or MCP tools | Yes | `c.get('appContext').serviceName` | SessionManager, WorktreeService, AnnotationService |
| **Internal service** — dependency of another service | No | Constructor or function parameter | `deleteWorktree(params, { worktreeService, sessionManager })` |
| **Stateless utility** — no state, no side effects | No | Direct import | logger, config readers, pure functions, type definitions |

### First-Class Services (AppContext)

Services that cross the **request boundary** — i.e., route handlers and MCP tool handlers access them directly. AppContext is the DI container for the Hono request lifecycle.

```typescript
// Registering in app-context.ts
export interface AppContext {
  sessionManager: SessionManager;
  worktreeService: WorktreeService;
  // ...
}

// Consuming in route handler
app.get('/api/worktrees', async (c) => {
  const { worktreeService } = c.get('appContext');
  // ...
});
```

### Internal Services (Parameter DI)

Services that are only used by other services. They accept their dependencies as constructor or function parameters — not via AppContext.

```typescript
// Function parameter DI
export async function deleteWorktree(
  params: DeleteWorktreeParams,
  deps: DeleteWorktreeDeps,  // { worktreeService, sessionManager, ... }
): Promise<DeleteWorktreeResult> { ... }

// Constructor DI
export class WorktreeService {
  constructor(db: Kysely<Database>) { ... }
}
```

### What NOT to Do

```typescript
// ❌ Module-level singleton — blocks test isolation
export const worktreeService = new WorktreeService();

// ❌ Calling getDatabase() inside a service — hidden global dependency
private get repository() {
  return new SqliteRepository(getDatabase());
}

// ❌ Importing a singleton in a route handler — untestable without mock.module
import { worktreeService } from '../services/worktree-service.js';
```

### Decision Flow for a New Service

1. Does a route handler or MCP tool use it? → **Add to AppContext** (first-class)
2. Is it only used by other services? → **Accept as parameter** (internal)
3. Is it stateless with no external deps? → **Direct import is fine** (utility)

## Core Concepts

### Session Manager

Central service managing all sessions and workers. Responsibilities:
- Create/delete sessions
- Spawn/manage workers (agent, terminal, git-diff)
- Track worker activity states
- Persist session state
- Broadcast lifecycle events

### Worker Types

- **Agent Worker** — PTY process running an AI agent (Claude Code, etc.)
- **Terminal Worker** — plain PTY shell
- **Git-Diff Worker** — non-PTY worker for real-time diff viewing

### PTY Management

- Use `bun-pty` for spawning interactive processes
- Workers persist across WebSocket reconnections (tmux-like behavior)
- Buffer output for history replay on reconnection

## Hono Framework

### Route Organization

```typescript
// routes/api.ts
const api = new Hono();
api.route('/sessions', sessions);
api.route('/agents', agents);
export { api };

// index.ts
app.route('/api', api);
```

### Request Validation (Valibot)

```typescript
import * as v from 'valibot';
import { vValidator } from '@hono/valibot-validator';

const schema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'Name is required'),
  ),
});

app.post('/items', vValidator('json', schema), (c) => {
  const data = c.req.valid('json');
  // data is typed
});
```

### Centralized Error Handling

```typescript
// lib/error-handler.ts
export function onApiError(err: Error, c: Context): Response {
  // Log and return appropriate HTTP response
}

// index.ts
app.onError(onApiError);
```

## Structured Logging — Code Patterns

The rule states the requirement (Pino, context object first). This is the idiomatic pattern with good/bad examples:

```typescript
import { createLogger } from './lib/logger.js';

const logger = createLogger('service-name');

// ❌ String interpolation — loses structure
logger.info(`Worker ${workerId} created for session ${sessionId}`);

// ✅ Structured data first, message second
logger.info({ sessionId, workerId }, 'Worker created');

// ❌ Logging an Error object directly — breaks serialization
logger.error(error, 'Operation failed');

// ✅ Wrap the error in an `err` key
logger.error({ err: error, sessionId }, 'Operation failed');
```

### Log Levels

- `fatal`: application crash, unrecoverable errors
- `error`: errors that need attention
- `warn`: potentially problematic situations
- `info`: normal operational messages
- `debug`: detailed debugging information

## Async Patterns — Route Handlers

The rule bans fire-and-forget. This shows the common mistakes and the fix:

```typescript
// ❌ Fire-and-forget — error silently ignored
app.post('/sessions', (c) => {
  sessionManager.createSession(data);  // Promise ignored
  return c.json({ success: true });
});

// ❌ async handler without await — same problem
app.post('/sessions', async (c) => {
  sessionManager.createSession(data);  // Still fire-and-forget
  return c.json({ success: true });
});

// ✅ Proper async/await
app.post('/sessions', async (c) => {
  try {
    const session = await sessionManager.createSession(data);
    return c.json(session);
  } catch (error) {
    logger.error({ err: error }, 'Failed to create session');
    throw error;  // Let the centralized handler respond
  }
});
```

## Async Patterns — Callbacks and Event Handlers

```typescript
// ❌ Fire-and-forget in callback
worker.onData((data) => {
  persistToFile(data);  // Promise ignored
});

// ✅ Async callback with error handling
worker.onData(async (data) => {
  try {
    await persistToFile(data);
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist data');
  }
});
```

## Process-Level Error Handling

Safety net for unhandled rejections, not a substitute for proper await/catch:

```typescript
// lib/error-handler.ts
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled promise rejection');
  // Optionally: graceful shutdown
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
```

## Callback Registration and Detachment

The rule says "always detach callbacks when resources are destroyed." This is the pattern:

```typescript
// ❌ Memory leak: callbacks never detached
class SessionManager {
  attachWorkerCallbacks(workerId: string, callbacks: Callbacks) {
    this.workerCallbacks.set(workerId, callbacks);
  }
  // No detach method!
}

// ✅ Proper callback lifecycle
class SessionManager {
  attachWorkerCallbacks(workerId: string, callbacks: Callbacks) {
    this.workerCallbacks.set(workerId, callbacks);
  }

  detachWorkerCallbacks(workerId: string) {
    this.workerCallbacks.delete(workerId);
  }
}

// In WebSocket handler
onClose() {
  sessionManager.detachWorkerCallbacks(sessionId, workerId);
}
```

## Resource Cleanup — Full Pattern

The rule lists the 4 resource categories (PTY processes, WebSocket connections, file handles, event listeners) and says cleanup should not throw. This is the worked pattern:

```typescript
class Worker {
  private pty: Pty;
  private callbacks: Map<string, () => void> = new Map();

  destroy() {
    // 1. Kill PTY process (handle failures gracefully)
    try {
      this.pty.kill();
    } catch (error) {
      logger.warn({ err: error }, 'Error killing PTY during cleanup');
    }

    // 2. Detach all callbacks to prevent memory leaks
    this.callbacks.forEach((unsubscribe) => unsubscribe());
    this.callbacks.clear();

    // 3. Close any open file handles
    // ...
  }
}
```

## WebSocket Message Typing

Define and validate message types explicitly for both directions:

```typescript
// packages/shared/src/types/websocket.ts

// Server → Client messages
type AppServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session-created'; session: Session }
  | { type: 'worker-activity'; sessionId: string; workerId: string; state: ActivityState };

// Client → Server messages
type AppClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string };

// Validate incoming messages with Valibot
const AppClientMessageSchema = v.variant('type', [
  v.object({ type: v.literal('subscribe'), sessionId: v.string() }),
  v.object({ type: v.literal('unsubscribe'), sessionId: v.string() }),
]);
```

## PTY Output Buffering

Buffer rapid PTY output before sending to WebSocket to reduce message frequency:

```typescript
// ❌ Sends every byte immediately — high message frequency
pty.onData((data) => {
  ws.send(data);
});

// ✅ Buffer output and flush periodically
class OutputBuffer {
  private buffer = '';
  private flushTimeout: Timer | null = null;

  append(data: string) {
    this.buffer += data;
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), 16); // ~60fps
    }
  }

  private flush() {
    if (this.buffer) {
      this.ws.send(this.buffer);
      this.buffer = '';
    }
    this.flushTimeout = null;
  }
}
```

## Async-Over-Sync — Exceptions and Examples

The rule's table covers the common replacements. Two narrow exceptions to the async-only default:

- **Application startup/initialization**: sync operations during server bootstrap (before accepting requests) are acceptable since no requests are blocked.
- **CLI tools**: command-line scripts that run to completion may use sync operations.

Worked example of the cost of ignoring the rule:

```typescript
// ❌ Blocks the event loop — all other requests wait
const config = fs.readFileSync('config.json', 'utf-8');
const data = JSON.parse(config);

// ✅ Non-blocking — other requests continue processing
const file = Bun.file('config.json');
const data = await file.json();

// ✅ Alternative with fs.promises
import { readFile } from 'fs/promises';
const config = await readFile('config.json', 'utf-8');
const data = JSON.parse(config);
```

## Configuration

Typed configuration with environment variables:

```typescript
// lib/server-config.ts
export const serverConfig = {
  PORT: process.env.PORT || '3001',
  NODE_ENV: process.env.NODE_ENV || 'development',
  AGENT_CONSOLE_HOME: process.env.AGENT_CONSOLE_HOME || path.join(homedir(), '.agent-console'),
};
```

## Testing (brief)

- Place tests in `__tests__/` directories at the same level as the production file
- Use Vitest
- Mock external dependencies (file system, processes) via injection — see the Dependency Injection Policy above

For detailed test patterns, see the [test-standards skill](../test-standards/SKILL.md).

## Connection Management

- Clean up dead WebSocket connections
- Use timeouts for operations
- Handle reconnection gracefully

See [websocket-patterns.md](websocket-patterns.md) for the dual-architecture implementation and broadcast patterns, and [webhook-receiver-patterns.md](webhook-receiver-patterns.md) for webhook receiver specifics.
