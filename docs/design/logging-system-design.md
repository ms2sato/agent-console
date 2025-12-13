# Logging System Design Document

## Background

The current codebase uses ad-hoc `console.log/error` calls (70+ in server, 35+ in client) with no consistent structure. This creates several problems:

- No log levels (debug logs always visible in production)
- Inconsistent prefixes (`[ActivityDetector]`, `[WS]`, etc.)
- No structured data (difficult to parse/filter)
- No request/session tracing across components
- Poor error context (stack traces without state)

## Goals

1. Introduce structured logging with consistent format
2. Enable log level filtering (debug off by default in production)
3. Provide context propagation for request/session tracing
4. Maintain high performance (PTY output can be high-volume)
5. Keep the implementation simple and maintainable

## Library Selection: Pino

**Pino** is chosen for the following reasons:

| Criteria | Pino |
|----------|------|
| Performance | Fastest Node.js logger (important for high PTY throughput) |
| Structured logging | JSON by default |
| Log levels | Built-in (trace, debug, info, warn, error, fatal) |
| Child loggers | Native support for context propagation |
| Bun compatibility | Works well with Bun runtime |
| Hono integration | `hono-pino` middleware available |
| Dev experience | `pino-pretty` for readable development logs |

### Dependencies

```bash
# Server
bun add pino hono-pino

# Dev dependencies
bun add -d pino-pretty @types/pino
```

## Log Levels

| Level | Value | Usage |
|-------|-------|-------|
| `fatal` | 60 | System crash, unrecoverable errors |
| `error` | 50 | Recoverable errors, exceptions |
| `warn` | 40 | Warnings, deprecated usage, unexpected states |
| `info` | 30 | Business events (session/worker lifecycle) |
| `debug` | 20 | Development details (activity detection) |
| `trace` | 10 | Very detailed debugging (rarely used) |

**Default level**: `info` in production, `debug` in development.

Configured via environment variable: `LOG_LEVEL=info`

## Log Format

### JSON Structure (Production)

```json
{
  "level": 30,
  "time": 1702483200000,
  "pid": 12345,
  "hostname": "server-01",
  "service": "session-manager",
  "sessionId": "sess_abc123",
  "workerId": "worker_xyz789",
  "msg": "Worker created",
  "workerType": "agent",
  "agentId": "claude-code"
}
```

### Pretty Format (Development)

```
[14:30:00.123] INFO (session-manager): Worker created
    sessionId: "sess_abc123"
    workerId: "worker_xyz789"
    workerType: "agent"
```

## Implementation Design

### Directory Structure

```
packages/server/src/
├── lib/
│   └── logger.ts              # Logger factory and configuration
├── middleware/
│   └── request-logger.ts      # Hono HTTP request logging
└── services/
    └── *.ts                   # Use createLogger('service-name')
```

### Logger Factory

```typescript
// packages/server/src/lib/logger.ts
import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

export const createLogger = (service: string) =>
  rootLogger.child({ service });
```

### Service Logger Usage

```typescript
// packages/server/src/services/session-manager.ts
import { createLogger } from '../lib/logger';

const logger = createLogger('session-manager');

export class SessionManager {
  createSession(params: CreateSessionParams): Session {
    const session = { /* ... */ };
    logger.info({ sessionId: session.id, type: session.type }, 'Session created');
    return session;
  }

  deleteSession(sessionId: string): void {
    logger.info({ sessionId }, 'Session deleted');
  }
}
```

### WebSocket Context Logger

```typescript
// packages/server/src/websocket/routes.ts
import { createLogger } from '../lib/logger';

const baseLogger = createLogger('websocket');

// Per-connection logger with context
const wsLogger = baseLogger.child({
  sessionId,
  workerId,
  clientId: crypto.randomUUID().slice(0, 8),
});

wsLogger.info('Client connected');
wsLogger.debug({ messageType: msg.type }, 'Message received');
wsLogger.warn({ code: 1006 }, 'Connection closed abnormally');
```

### HTTP Request Logging

```typescript
// packages/server/src/middleware/request-logger.ts
import { pinoLogger } from 'hono-pino';
import { rootLogger } from '../lib/logger';

export const requestLogger = pinoLogger({
  pino: rootLogger.child({ service: 'http' }),
});

// Usage in app.ts
app.use('*', requestLogger);
```

## Key Log Points

### Server Lifecycle

| Event | Level | Context |
|-------|-------|---------|
| Server starting | `info` | port, env, version |
| Server ready | `info` | - |
| Server shutdown | `info` | reason |
| Uncaught exception | `fatal` | error, stack |
| Unhandled rejection | `fatal` | error, stack |

### Session/Worker Lifecycle

| Event | Level | Context |
|-------|-------|---------|
| Session created | `info` | sessionId, type, workDir |
| Session deleted | `info` | sessionId |
| Worker created | `info` | sessionId, workerId, workerType |
| Worker exited | `info` | sessionId, workerId, exitCode, signal |
| Activity state changed | `debug` | sessionId, workerId, prevState, newState |

### WebSocket

| Event | Level | Context |
|-------|-------|---------|
| Client connected | `info` | sessionId, workerId, clientId |
| Client disconnected | `info` | sessionId, workerId, clientId |
| Connection error | `warn` | sessionId, workerId, error |
| Message received | `debug` | sessionId, workerId, messageType |

### PTY

| Event | Level | Context |
|-------|-------|---------|
| PTY spawned | `info` | sessionId, workerId, command |
| PTY exited | `info` | sessionId, workerId, exitCode |
| PTY error | `error` | sessionId, workerId, error |

**Note**: PTY output data is NOT logged (too high volume). Buffer size can be logged periodically at `debug` level if needed.

### Errors

| Event | Level | Context |
|-------|-------|---------|
| API error | `error` | method, path, status, error |
| Validation error | `warn` | method, path, issues |
| Internal error | `error` | service, operation, error, stack |

## Performance Considerations

### What NOT to Log

```typescript
// NEVER log raw PTY output
pty.onData((data) => {
  // logger.trace({ data }, 'PTY output'); // DON'T DO THIS
});

// NEVER log WebSocket binary data
ws.on('message', (data) => {
  // logger.debug({ data }, 'WS message'); // DON'T DO THIS
  logger.debug({ type: parsed.type }, 'WS message'); // Log type only
});
```

### Conditional Debug Logging

```typescript
// Use logger.isLevelEnabled() for expensive operations
if (logger.isLevelEnabled('debug')) {
  const stats = computeExpensiveStats();
  logger.debug({ stats }, 'Buffer statistics');
}
```

## Client-Side Logging

The client uses standard `console` methods. Debug logs are stripped in production builds.

```typescript
// Development only
if (import.meta.env.DEV) {
  console.debug('[WebSocket] Connected');
}
```

No server-side error reporting is implemented (as per requirements).

## Migration Strategy

### Phase 1: Foundation

1. Add Pino dependencies
2. Create `logger.ts` factory
3. Replace `console.log` in `index.ts` (server startup)

### Phase 2: Core Services

1. Add logging to `SessionManager`
2. Add logging to `WorkerManager` (within sessions)
3. Add logging to `AgentRegistry`

### Phase 3: WebSocket

1. Add context logger to worker connections
2. Add logging to dashboard connection
3. Replace existing `console.error` calls

### Phase 4: Activity Detection

1. Replace `ActivityDetector` console.log with `debug` level
2. Add state transition logging at `debug` level

### Phase 5: Error Handling

1. Integrate logging into error handler middleware
2. Add context to all error logs
3. Remove remaining `console.error` calls

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | Minimum log level |
| `NODE_ENV` | - | `development` enables pretty printing |

### Example Configuration

```bash
# Production
LOG_LEVEL=info bun run start

# Development (default)
bun run dev  # Uses debug level with pretty output

# Verbose debugging
LOG_LEVEL=trace bun run dev
```

## Future Considerations

Not in scope for initial implementation, but may be considered later:

- **Log aggregation**: Ship logs to external service (Datadog, Loki, etc.)
- **Request ID tracing**: Propagate trace ID across HTTP and WebSocket
- **Metrics integration**: Export metrics alongside logs
- **Audit logging**: Separate audit trail for compliance

## References

- [Pino documentation](https://getpino.io/)
- [hono-pino middleware](https://github.com/maou-shonen/hono-pino)
- [pino-pretty formatter](https://github.com/pinojs/pino-pretty)
