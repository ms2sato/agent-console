# Backend Standards

This document defines backend-specific knowledge and patterns for the agent-console project.

## Tech Stack

- **Bun** - JavaScript runtime
- **Hono** - Web framework
- **bun-pty** - Pseudo-terminal for spawning processes
- **Pino** - Structured logging
- **Valibot** - Schema validation (shared with frontend)

## Directory Structure and Naming

```
packages/server/src/
├── __tests__/      # Unit tests
├── lib/            # Utilities (logger, config, error handler)
├── middleware/     # Hono middleware
├── routes/         # API route handlers
├── services/       # Business logic (flat by default, domain dirs when needed)
│   ├── agents/     # Domain directory (multiple related files)
│   └── *.ts        # Flat service files
└── websocket/      # WebSocket handlers
```

### Directory Organization Strategy

**Services use flat-first approach:**
- Keep services as flat files by default
- Create domain directory when a service needs multiple related files

| Situation | Organization | Example |
|-----------|--------------|---------|
| Single service file | Flat | `services/session-manager.ts` |
| Service + helpers/types | Domain directory | `services/agents/` |
| Service grows large | Split into domain directory | - |

Decision criteria:
1. **Single file sufficient** → Keep flat
2. **2+ closely related files** → Create domain directory
3. **Splitting for readability** → Create domain directory

### File Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| General | kebab-case | `session-manager.ts` |
| Service | kebab-case | `persistence-service.ts` |
| Middleware | kebab-case | `error-handler.ts` |
| Route handler | kebab-case (plural) | `sessions.ts`, `workers.ts` |
| Utility | kebab-case | `config.ts`, `logger.ts` |
| Test | original + `.test` | `session-manager.test.ts` |

### Directory Naming

- Use **kebab-case** for all directories
- Exception: `__tests__/` follows Node.js convention with underscores

### Export Conventions

- File name reflects the primary export: `session-manager.ts` exports `SessionManager`
- Use named exports for multiple related items
- Avoid default exports except for route handlers

## Core Concepts

### Session Manager

Central service managing all sessions and workers. Responsibilities:
- Create/delete sessions
- Spawn/manage workers (agent, terminal, git-diff)
- Track worker activity states
- Persist session state
- Broadcast lifecycle events

### Workers

Three types of workers:
- **Agent Worker**: PTY process running AI agent (Claude Code, etc.)
- **Terminal Worker**: Plain PTY shell
- **Git-Diff Worker**: Non-PTY worker for real-time diff viewing

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

### Request Validation

Use Valibot with Hono's validator:

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

### Error Handling

Use centralized error handler:

```typescript
// lib/error-handler.ts
export function onApiError(err: Error, c: Context): Response {
  // Log and return appropriate HTTP response
}

// index.ts
app.onError(onApiError);
```

## Logging

Use Pino with structured logging:

```typescript
import { createLogger } from './lib/logger.js';

const logger = createLogger('service-name');

// Structured data first, message second
logger.info({ sessionId, workerId }, 'Worker created');
logger.error({ err: error, context }, 'Operation failed');
```

### Log Levels

- `fatal`: Application crash, unrecoverable errors
- `error`: Errors that need attention
- `warn`: Potentially problematic situations
- `info`: Normal operational messages
- `debug`: Detailed debugging information

## Service Design

### Singleton Services

Use module-level singletons for shared services:

```typescript
// services/session-manager.ts
class SessionManager {
  // ...implementation
}

export const sessionManager = new SessionManager();
```

### Callback Patterns

For async notifications, use callback registration:

```typescript
class SessionManager {
  private activityCallback?: (sessionId: string, workerId: string, state: AgentActivityState) => void;

  setGlobalActivityCallback(callback: typeof this.activityCallback) {
    this.activityCallback = callback;
  }
}
```

### Resource Cleanup

Always clean up resources:

```typescript
// Process termination handlers
process.on('SIGTERM', () => cleanup());
process.on('SIGINT', () => cleanup());

// Worker cleanup
onClose() {
  sessionManager.detachWorkerCallbacks(sessionId, workerId);
}
```

## Configuration

Use typed configuration with environment variables:

```typescript
// lib/server-config.ts
export const serverConfig = {
  PORT: process.env.PORT || '3001',
  NODE_ENV: process.env.NODE_ENV || 'development',
  AGENT_CONSOLE_HOME: process.env.AGENT_CONSOLE_HOME || path.join(homedir(), '.agent-console'),
};
```

## Testing

### Unit Tests

- Place tests in `__tests__/` directories
- Use Vitest
- Mock external dependencies (file system, processes)

### Integration Tests

- Test API endpoints with real HTTP requests
- Test WebSocket connections

### Test Patterns

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ServiceName', () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  it('should do something', () => {
    // Test
  });
});
```

## Security

### Input Validation

- Validate all API inputs at boundaries
- Use Valibot schemas
- Never trust client-provided data

### Process Spawning

- Sanitize environment variables before spawning
- Don't expose sensitive env vars to child processes

### File System Access

- Validate paths to prevent directory traversal
- Use absolute paths
- Check file existence before operations

## Performance

### Prefer Async Over Sync

**Always use async functions instead of sync equivalents.**

Bun runs on a single-threaded event loop. Sync functions block the entire thread, preventing all other requests from being processed until the operation completes. This directly impacts server responsiveness and throughput.

| Avoid (Sync) | Use (Async) |
|--------------|-------------|
| `fs.readFileSync()` | `fs.promises.readFile()` or `Bun.file().text()` |
| `fs.writeFileSync()` | `fs.promises.writeFile()` or `Bun.write()` |
| `fs.existsSync()` | `fs.promises.access()` or `Bun.file().exists()` |
| `fs.mkdirSync()` | `fs.promises.mkdir()` |
| `fs.readdirSync()` | `fs.promises.readdir()` |
| `fs.statSync()` | `fs.promises.stat()` |
| `fs.rmSync()` | `fs.promises.rm()` |
| `child_process.execSync()` | `child_process.exec()` with promisify or `Bun.spawn()` |
| `child_process.spawnSync()` | `Bun.spawn()` |

**Exceptions:**
- **Application startup/initialization**: Sync operations during server bootstrap (before accepting requests) are acceptable since no requests are blocked
- **CLI tools**: Command-line scripts that run to completion may use sync operations

**Example:**

```typescript
// ❌ Blocks the event loop - all other requests wait
const config = fs.readFileSync('config.json', 'utf-8');
const data = JSON.parse(config);

// ✅ Non-blocking - other requests continue processing
const file = Bun.file('config.json');
const data = await file.json();

// ✅ Alternative with fs.promises
import { readFile } from 'fs/promises';
const config = await readFile('config.json', 'utf-8');
const data = JSON.parse(config);
```

### Async/Await and Fire-and-Forget

**Always use async/await. Avoid fire-and-forget patterns.**

Fire-and-forget (calling an async function without awaiting) is problematic because:
- **Silent errors:** Errors are never caught, making debugging extremely difficult
- **Race conditions:** Operations complete in unpredictable order
- **Difficult tracing:** Stack traces are lost when promises are not awaited
- **Unhandled rejections:** Can crash the process or leave it in an inconsistent state

#### Route Handlers

```typescript
// ❌ Fire-and-forget - error silently ignored
app.post('/sessions', (c) => {
  sessionManager.createSession(data);  // Promise ignored
  return c.json({ success: true });
});

// ❌ async handler without await - same problem
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
    throw error;  // Let error handler respond appropriately
  }
});
```

#### Callbacks and Event Handlers

```typescript
// ❌ Fire-and-forget in callback
worker.onData((data) => {
  persistToFile(data);  // Promise ignored
});

// ✅ Proper async callback with error handling
worker.onData(async (data) => {
  try {
    await persistToFile(data);
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist data');
  }
});
```

#### Process-Level Error Handling

Add process-level handlers as a safety net for unhandled rejections:

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

**Note:** Process-level handlers are a safety net, not a substitute for proper await/catch patterns.

### PTY Output Handling

- Buffer output to reduce message frequency
- Use efficient string concatenation
- Limit history buffer size

### Connection Management

- Clean up dead WebSocket connections
- Use timeouts for operations
- Handle reconnection gracefully

## Backend Best Practices

### Resource Cleanup Checklist

When creating resources that need cleanup:

1. **PTY Processes** - Kill processes when workers are destroyed
2. **WebSocket Connections** - Close connections on disconnect, handle cleanup in `onClose`
3. **File Handles** - Close file handles after operations complete
4. **Event Listeners** - Remove listeners when resources are destroyed

```typescript
// ✅ Proper cleanup pattern
class Worker {
  private pty: Pty;
  private callbacks: Map<string, () => void> = new Map();

  destroy() {
    // 1. Kill PTY process
    this.pty.kill();

    // 2. Detach all callbacks to prevent memory leaks
    this.callbacks.forEach((unsubscribe) => unsubscribe());
    this.callbacks.clear();

    // 3. Close any open file handles
    // ...
  }
}
```

### Callback Registration and Detachment

**Always detach callbacks when resources are destroyed** to prevent memory leaks:

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

### WebSocket Message Types

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

### PTY Output Buffering

Buffer rapid PTY output before sending to WebSocket to reduce message frequency:

```typescript
// ❌ Sends every byte immediately - high message frequency
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

### Structured Logging Best Practices

```typescript
// ❌ Avoid: string interpolation
logger.info(`Worker ${workerId} created for session ${sessionId}`);

// ✅ Prefer: structured data first, message second
logger.info({ sessionId, workerId }, 'Worker created');

// ❌ Avoid: logging objects directly
logger.error(error, 'Operation failed');

// ✅ Prefer: wrap error in `err` key for proper serialization
logger.error({ err: error, sessionId }, 'Operation failed');
```
