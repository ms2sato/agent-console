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

## WebSocket Patterns

### Dual WebSocket Architecture

1. **App WebSocket (`/ws/app`)**: Single connection for app-wide state sync
   - Broadcasts session/worker lifecycle events
   - Client uses singleton pattern

2. **Worker WebSocket (`/ws/session/:id/worker/:id`)**: Per-worker connections
   - Handles terminal I/O, resize, image upload
   - Tied to specific session/worker

### Message Protocol

Server → Client messages are typed:

```typescript
type WorkerServerMessage =
  | { type: 'output'; data: string }
  | { type: 'history'; data: string }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'activity'; state: AgentActivityState };
```

### Broadcasting

For app-wide events, use broadcast pattern:

```typescript
const appClients = new Set<WSContext>();

function broadcastToApp(msg: AppServerMessage): void {
  const msgStr = JSON.stringify(msg);
  for (const client of appClients) {
    client.send(msgStr);
  }
}
```

### Output Buffering

Buffer rapid PTY output to reduce WebSocket message count:

```typescript
let outputBuffer = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 50; // ms

const flushBuffer = () => {
  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
    outputBuffer = '';
  }
  flushTimer = null;
};
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

### PTY Output Handling

- Buffer output to reduce message frequency
- Use efficient string concatenation
- Limit history buffer size

### Connection Management

- Clean up dead WebSocket connections
- Use timeouts for operations
- Handle reconnection gracefully
