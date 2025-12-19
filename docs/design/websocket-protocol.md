# WebSocket Protocol Design

This document defines the WebSocket protocol used for real-time communication between client and server.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/ws/app` | App-wide state synchronization (sessions, worker activity) |
| `/ws/session/:sessionId/worker/:workerId` | Individual worker I/O (terminal input/output) |

## App Connection (`/ws/app`)

Singleton WebSocket connection for app-wide state synchronization. Persists across route navigation.

### Server → Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `sessions-sync` | `{ sessions: Session[], activityStates: WorkerActivityInfo[] }` | Full session list with activity states. Sent on initial connection and in response to `request-sync`. |
| `session-created` | `{ session: Session }` | New session created |
| `session-updated` | `{ session: Session }` | Session updated (title, branch, etc.) |
| `session-deleted` | `{ sessionId: string }` | Session deleted |
| `worker-activity` | `{ sessionId, workerId, activityState }` | Worker activity state changed |

### Client → Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `request-sync` | (none) | Request full session sync |

### Design Decisions

#### Why `request-sync` exists

The WebSocket connection is a singleton that persists across route navigation. When users navigate away from Dashboard and return, the connection is already established, so the server doesn't send `sessions-sync` automatically (which only happens on `onOpen`).

The client sends `request-sync` when Dashboard mounts and the WebSocket is already connected, ensuring fresh state after navigation.

#### Future Extension: scope parameter

Currently, `request-sync` only returns session data. If future pages require different data via WebSocket, the protocol can be extended with a `scope` parameter:

```typescript
// Current (implicit scope: sessions)
{ type: 'request-sync' }

// Future extension
{ type: 'request-sync', scope: 'sessions' }
{ type: 'request-sync', scope: ['sessions', 'agents'] }
```

This is similar to SQL JOINs - explicitly specifying what data to fetch. The server would respond with the appropriate `*-sync` message(s).

**Note:** Only add scope when there's a concrete need. Static data (agents, repositories) should use REST API unless real-time sync is required.

## Worker Connection (`/ws/session/:sessionId/worker/:workerId`)

Per-worker WebSocket for terminal I/O.

### Client → Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `input` | `{ data: string }` | Terminal input |
| `resize` | `{ cols: number, rows: number }` | Terminal resize |
| `image` | `{ data: string, mimeType: string }` | Image data (base64) |

### Server → Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `output` | `{ data: string }` | PTY output |
| `exit` | `{ exitCode: number, signal: string \| null }` | Process exit |
| `history` | `{ data: string }` | Buffered output on reconnect |
| `activity` | `{ state: AgentActivityState }` | Agent activity state change (agent workers only) |

## Reconnection Strategy

See [websocket-reconnection.md](../websocket-reconnection.md) for exponential backoff parameters.

Summary:
- Initial delay: 1s
- Max delay: 30s (with ±30% jitter)
- Backoff sequence: 1s → 2s → 4s → 8s → 16s → 30s → 30s...

## Type Definitions

See `packages/shared/src/types/session.ts` for:
- `APP_SERVER_MESSAGE_TYPES` - Valid server → client message types
- `APP_CLIENT_MESSAGE_TYPES` - Valid client → server message types
- `AppServerMessage` - Union type for server messages
- `AppClientMessage` - Union type for client messages
