# WebSocket Patterns

This document defines WebSocket-specific patterns for the agent-console project.

## Dual WebSocket Architecture

1. **App WebSocket (`/ws/app`)**: Single connection for app-wide state sync
   - Broadcasts session/worker lifecycle events
   - Client uses singleton pattern

2. **Worker WebSocket (`/ws/session/:id/worker/:id`)**: Per-worker connections
   - Handles terminal I/O, resize, image upload
   - Tied to specific session/worker

## Message Protocol

Server → Client messages are typed:

```typescript
type WorkerServerMessage =
  | { type: 'output'; data: string }
  | { type: 'history'; data: string }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'activity'; state: AgentActivityState };
```

## Broadcasting

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

## Output Buffering

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

## Connection Management

- Clean up dead WebSocket connections
- Use timeouts for operations
- Handle reconnection gracefully
