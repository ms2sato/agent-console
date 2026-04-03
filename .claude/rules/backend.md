---
paths:
  - "packages/server/**"
---

# Backend Rules

**Delegate to `backend-specialist` subagent** for implementation in this package. Primary agent should not write server code directly.

## Directory Structure

```
packages/server/src/
├── lib/            # Utilities (logger, config, error handler)
├── middleware/     # Hono middleware
├── routes/         # API route handlers
├── services/       # Business logic (flat by default, domain dirs when needed)
└── websocket/      # WebSocket handlers
```

Services use **flat-first** approach: start as flat files, move to domain directory when helpers/types grow.

## File Naming

- **kebab-case** for all files and directories (exception: `__tests__/`)
- Route handlers use **plural** names: `sessions.ts`, `workers.ts`
- File name reflects primary export: `session-manager.ts` → `SessionManager`
- Test files: `__tests__/foo-bar.test.ts`
- Use named exports; avoid default exports

## Key Principles

- **Server is the source of truth** — backend manages all session/worker state
- **Structured logging** — Pino with context objects first, message second:
  ```typescript
  logger.info({ sessionId, workerId }, 'Worker created');
  ```
  Avoid string interpolation in log messages.

## Async Over Sync (Critical)

Bun runs on a single-threaded event loop. **Sync functions block the entire thread.**

| Avoid (Sync) | Use (Async) |
|--------------|-------------|
| `fs.readFileSync()` | `Bun.file().text()` |
| `fs.writeFileSync()` | `Bun.write()` |
| `fs.existsSync()` | `Bun.file().exists()` |
| `child_process.execSync()` | `Bun.spawn()` |

Exceptions: Application startup/initialization and CLI tools.

**Never use fire-and-forget patterns.** Always await async operations to avoid silent errors and race conditions.

## Resource Cleanup

Always clean up resources. Cleanup operations should not throw — wrap in try-catch and log warnings.

1. **PTY Processes** — Kill processes when workers are destroyed
2. **WebSocket Connections** — Close connections on disconnect, handle cleanup in `onClose`
3. **File Handles** — Close file handles after operations complete
4. **Event Listeners** — Remove listeners when resources are destroyed

**Always detach callbacks when resources are destroyed** to prevent memory leaks. Every `attachWorkerCallbacks` must have a corresponding `detachWorkerCallbacks`.

## WebSocket Architecture

1. **App WebSocket (`/ws/app`)** — App-wide state sync (session/worker lifecycle events)
2. **Worker WebSocket (`/ws/session/:id/worker/:id`)** — Per-worker connections (terminal I/O, resize)

## Security

- Validate all API inputs at boundaries using Valibot schemas
- External service payloads MUST be parsed with Valibot schemas (not manual field extraction)
- Sanitize environment variables before spawning processes
- Validate paths to prevent directory traversal
- Use absolute paths
