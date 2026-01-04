# Terminal State Synchronization

This document describes the architecture for synchronizing terminal state between client and server, including caching and incremental sync mechanisms.

## Problem Statement

When users switch between worker tabs, the terminal component unmounts and remounts. Without caching, the full terminal history must be fetched from the server on each mount, causing:

1. **Visual flicker**: Terminal clears and repopulates
2. **Network overhead**: Full history transfer on every tab switch
3. **Latency**: Users wait for history to load

## Solution Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Client                                     │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────────────┐ │
│  │  Terminal   │───▶│ IndexedDB    │    │   WebSocket             │ │
│  │  Component  │◀───│ Cache        │    │   Connection            │ │
│  │             │    │              │    │                         │ │
│  │  (xterm.js) │    │ - state      │    │ request-history         │ │
│  │             │    │ - offset     │───▶│ { fromOffset: 12345 }   │ │
│  └─────────────┘    │ - savedAt    │    │                         │ │
│                     └──────────────┘    └───────────┬─────────────┘ │
└─────────────────────────────────────────────────────┼───────────────┘
                                                      │
                                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Server                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    SessionManager                            │    │
│  │  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐  │    │
│  │  │   Worker    │    │ Output File  │    │ In-Memory      │  │    │
│  │  │             │───▶│              │    │ Buffer         │  │    │
│  │  │ outputOffset│    │ worker.txt   │    │                │  │    │
│  │  └─────────────┘    └──────────────┘    └────────────────┘  │    │
│  │                            │                                 │    │
│  │                            ▼                                 │    │
│  │                     readWithOffset(fromOffset)               │    │
│  │                            │                                 │    │
│  │                            ▼                                 │    │
│  │                     history { data, offset }                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Client-Side Caching

### IndexedDB Cache Structure

```typescript
interface CachedState {
  data: string;      // Serialized xterm.js terminal state
  savedAt: number;   // Timestamp for TTL check
  cols: number;      // Terminal columns at save time
  rows: number;      // Terminal rows at save time
  offset: number;    // Server-side byte offset at save time
}
```

**Key format**: `terminal:{sessionId}:{workerId}`

**TTL**: 24 hours (time-based expiration)

### Cache Lifecycle

1. **Save (on unmount)**:
   - Serialize terminal state using xterm.js SerializeAddon
   - Store with current server offset
   - Save to IndexedDB

2. **Load (on mount)**:
   - Check if cache exists and is not expired
   - Restore terminal state from cache (instant display)
   - Request incremental update with `fromOffset`

3. **Invalidate**:
   - TTL expiration (24 hours)
   - Invalid cache format
   - Worker restart (server resets output file)

### Terminal Component State Machine

```
┌─────────────────┐
│  initializing   │  (xterm.js not ready)
└────────┬────────┘
         │ xterm.js ready
         ▼
┌─────────────────┐    cache found    ┌─────────────────┐
│ loading-fresh   │◀─────────────────▶│  loading-diff   │
│ (no cache)      │   no cache        │  (has cache)    │
└────────┬────────┘                   └────────┬────────┘
         │ history received                    │ diff received
         ▼                                     ▼
┌─────────────────────────────────────────────────────┐
│                      ready                           │
│              (all history loaded)                    │
└─────────────────────────────────────────────────────┘
```

### State Flags

| Flag | Purpose |
|------|---------|
| `isMounted` | Prevents operations after unmount |
| `restoredFromCache` | Tracks if cache was restored (for diff handling) |
| `waitingForDiff` | Expects incremental history response |
| `historyRequested` | Prevents duplicate requests (React Strict Mode) |
| `cachedOffset` | Stored offset from cache for diff request |

## Server-Side Offset Tracking

### Offset Calculation

The server tracks output offset in bytes (not characters) for accurate file seeking:

```typescript
// In session-manager.ts
worker.pty.onData((data) => {
  worker.outputBuffer += data;
  worker.outputOffset += Buffer.byteLength(data, 'utf-8');
  // ...
});
```

### History Request Handling

```typescript
// In routes.ts
if (fromOffset !== undefined && fromOffset > 0) {
  // Incremental sync: read only new data
  history = await sessionManager.getWorkerOutputHistory(
    sessionId, workerId, fromOffset
  );
} else {
  // Full sync: read everything
  history = await sessionManager.getWorkerOutputHistory(
    sessionId, workerId
  );
}
```

### Output File Reading with Offset

```typescript
// In worker-output-file.ts
async readHistoryWithOffset(
  sessionId: string,
  workerId: string,
  fromOffset: number
): Promise<{ data: string; currentOffset: number }> {
  const filePath = this.getOutputFilePath(sessionId, workerId);
  const stats = await stat(filePath);

  if (fromOffset >= stats.size) {
    // No new data
    return { data: '', currentOffset: stats.size };
  }

  // Read from offset to end
  const fd = await open(filePath, 'r');
  const buffer = Buffer.alloc(stats.size - fromOffset);
  await fd.read(buffer, 0, buffer.length, fromOffset);
  await fd.close();

  return { data: buffer.toString('utf-8'), currentOffset: stats.size };
}
```

## Edge Cases

### Rapid Worker Switching

**Problem**: User switches tabs faster than async operations complete.

**Solution**: Check `isMounted` and worker identity before acting on async results:

```typescript
loadTerminalState(sessionId, workerId)
  .then((cached) => {
    if (!stateRef.current.isMounted) return;  // Unmounted
    // ... proceed
  });
```

### Connection Error During History Request

**Problem**: WebSocket disconnects before history response arrives.

**Solution**: Reset flags on disconnect:

```typescript
if (!connected) {
  stateRef.current.historyRequested = false;
  stateRef.current.waitingForDiff = false;
}
```

### Server Restart

**Problem**: Client cache has offset from before server restart. Server output file may be different.

**Current mitigation**: 24-hour TTL on cache.

**Future improvement**: Add server PID to cache for invalidation on restart.

### PTY Restart

**Problem**: Worker PTY crashes and restarts. Output file persists but may be inconsistent.

**Solution**: Clear output file on restart:

```typescript
// In session-manager.ts restartAgentWorker()
await workerOutputFileManager.resetWorkerOutput(sessionId, workerId);
```

## Known Limitations

### Alternate Buffer (xterm.js)

Full-screen applications like Claude Code use xterm.js's alternate buffer. The SerializeAddon only serializes the **active buffer**:

- **Main buffer**: Normal shell output (with scrollback)
- **Alternate buffer**: Full-screen TUI (no scrollback)

When Claude Code is running (alternate buffer active):
- Cache contains alternate buffer content (TUI state)
- Main buffer content (startup logo) is not cached
- On tab switch, logo disappears but functionality is preserved

**Impact**: Visual only. The TUI interaction history is fully preserved.

### Cache Size

Large terminal outputs can create large cache entries. Current implementation has no size limit.

**Recommendation**: Consider truncating cache for very large outputs (>1MB).

## Related Files

- `packages/client/src/lib/terminal-state-cache.ts` - IndexedDB cache operations
- `packages/client/src/components/Terminal.tsx` - Cache integration with xterm.js
- `packages/server/src/services/session-manager.ts` - Offset tracking, history retrieval
- `packages/server/src/lib/worker-output-file.ts` - File reading with offset
- `packages/server/src/websocket/routes.ts` - History request handling
- `packages/shared/src/types/session.ts` - Message type definitions
