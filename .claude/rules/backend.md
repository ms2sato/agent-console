---
paths:
  - "packages/server/**"
---

# Backend Rules

**Delegate to `backend-specialist` subagent** for implementation in this package. Primary agent should not write server code directly.

**Two sibling rules load alongside this one and are worth naming here, because neither is reachable from anywhere else.** Both used to load in every session and are now path-scoped, so a reader who never opens them will not stumble across them the way an always-loaded rule is stumbled across. Their scopes overlap this package but are not identical — check each file's own front matter rather than assuming they load together:

- [`elevation-helpers.md`](./elevation-helpers.md) (`packages/server/**`, `scripts/**`) — the contract for `privilege-elevation.ts`'s `runAsUser` / `spawnAsUser` / `rmRecursiveAsUser` family, and the reciprocal obligations a consumer inherits (closing stdin, `sh -s` for multi-line commands).
- [`os-environment-coupling.md`](./os-environment-coupling.md) (`packages/server/**`, `scripts/**`, `docker/**`, `.github/workflows/**`) — when a change touches privilege elevation, file ownership, systemd, PAM, or login-shell init, unit tests cannot establish correctness and a real-machine smoke is mandatory. The two extra patterns are deliberate: a workflow file or a container definition can break an OS coupling without any server source changing.

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
