---
paths:
  - "packages/server/**"
---

# Backend Rules

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

| Situation | Organization | Example |
|-----------|--------------|---------|
| Single service file | Flat | `services/session-manager.ts` |
| Service + helpers/types | Domain directory | `services/agents/` |
| Service grows large | Split into domain directory | - |

### File Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| General | kebab-case | `session-manager.ts` |
| Service | kebab-case | `persistence-service.ts` |
| Middleware | kebab-case | `error-handler.ts` |
| Route handler | kebab-case (plural) | `sessions.ts`, `workers.ts` |
| Utility | kebab-case | `config.ts`, `logger.ts` |
| Test | original + `.test` | `session-manager.test.ts` |

- Use **kebab-case** for all directories (exception: `__tests__/`)
- File name reflects primary export: `session-manager.ts` exports `SessionManager`
- Use named exports; avoid default exports except for route handlers

## Key Principles

- **Server is the source of truth** - Backend manages all session/worker state
- **Structured logging** - Use Pino with context objects
- **Resource cleanup** - Always clean up PTY processes and connections
- **Type safety** - Define types in shared package, validate at boundaries

## Hono Framework

### Route Organization

```typescript
const api = new Hono();
api.route('/sessions', sessions);
api.route('/agents', agents);
export { api };
```

### Request Validation

Use Valibot with Hono's validator (`@hono/valibot-validator`).

### Error Handling

Use centralized error handler via `app.onError(onApiError)`.

## Logging

Use Pino with structured logging:

```typescript
// Structured data first, message second
logger.info({ sessionId, workerId }, 'Worker created');
logger.error({ err: error, context }, 'Operation failed');
```

- `fatal`: Application crash, unrecoverable errors
- `error`: Errors that need attention
- `warn`: Potentially problematic situations
- `info`: Normal operational messages
- `debug`: Detailed debugging information

**Avoid string interpolation in log messages.** Use structured data objects.

## Service Design

### Singleton Services

Use module-level singletons for shared services.

### Callback Registration and Detachment

**Always detach callbacks when resources are destroyed** to prevent memory leaks. Every `attachWorkerCallbacks` must have a corresponding `detachWorkerCallbacks` in cleanup/`onClose`.

### Resource Cleanup

Always clean up resources. Cleanup operations should not throw - wrap in try-catch and log warnings.

1. **PTY Processes** - Kill processes when workers are destroyed
2. **WebSocket Connections** - Close connections on disconnect, handle cleanup in `onClose`
3. **File Handles** - Close file handles after operations complete
4. **Event Listeners** - Remove listeners when resources are destroyed

## Performance

### Prefer Async Over Sync

**Always use async functions instead of sync equivalents.** Bun runs on a single-threaded event loop. Sync functions block the entire thread.

| Avoid (Sync) | Use (Async) |
|--------------|-------------|
| `fs.readFileSync()` | `Bun.file().text()` |
| `fs.writeFileSync()` | `Bun.write()` |
| `fs.existsSync()` | `Bun.file().exists()` |
| `child_process.execSync()` | `Bun.spawn()` |

**Exceptions:** Application startup/initialization and CLI tools.

### Async/Await

**Always use async/await. Avoid fire-and-forget patterns.** Fire-and-forget causes silent errors, race conditions, and unhandled rejections.

### PTY Output Handling

- Buffer output to reduce message frequency
- Use efficient string concatenation
- Limit history buffer size

## Dual WebSocket Architecture

1. **App WebSocket (`/ws/app`)**: Single connection for app-wide state sync (session/worker lifecycle events)
2. **Worker WebSocket (`/ws/session/:id/worker/:id`)**: Per-worker connections (terminal I/O, resize)

### Message Protocol

Server -> Client messages are typed discriminated unions. Client -> Server messages are validated with Valibot schemas.

### Broadcasting

Use broadcast pattern with `Set<WSContext>` for app-wide events.

### Output Buffering

Buffer rapid PTY output before sending to WebSocket to reduce message count.

## Webhook Receiver Patterns

**These patterns apply to webhook receivers only, NOT regular API endpoints.**

- **Always return 200 OK** to the webhook sender, regardless of internal processing results
- Accept events and process asynchronously (enqueue + return)
- Verify webhook signatures before enqueuing, but still return 200 on auth failure
- All failures are handled internally through logging, alerting, and internal retry

| Aspect | Webhook Receiver | API Endpoint |
|--------|-----------------|--------------|
| Response codes | Always 200 | Proper HTTP codes |
| Processing | Async (enqueue + return) | Sync (process + respond) |
| Error reporting | Internal (logs, alerts) | To caller (error response) |

## Security

- Validate all API inputs at boundaries using Valibot schemas
- External service payloads MUST be parsed with Valibot schemas (not manual field extraction)
- Sanitize environment variables before spawning processes
- Validate paths to prevent directory traversal
- Use absolute paths

## Configuration

Use typed configuration with environment variables (`lib/server-config.ts`).

## Core Concepts

### Session Manager

Central service managing all sessions and workers (create/delete sessions, spawn/manage workers, track activity states, persist state, broadcast events).

### Workers

- **Agent Worker**: PTY process running AI agent (Claude Code, etc.)
- **Terminal Worker**: Plain PTY shell
- **Git-Diff Worker**: Non-PTY worker for real-time diff viewing

### PTY Management

- Use `bun-pty` for spawning interactive processes
- Workers persist across WebSocket reconnections (tmux-like behavior)
- Buffer output for history replay on reconnection
