# WebSocket Reconnection Strategy

The dashboard WebSocket uses exponential backoff with jitter to handle disconnections gracefully.

## Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| INITIAL_RETRY_DELAY | 1s | First retry happens quickly since most disconnects are brief (server restart, network hiccup). Users expect fast recovery. |
| MAX_RETRY_DELAY | 30s | Caps the backoff to prevent excessive waits during extended outages. 30s balances between not hammering the server and providing reasonable recovery time. |
| JITTER_FACTOR | ±30% | Randomizes retry timing to prevent "thundering herd" when multiple clients reconnect simultaneously after server recovery. |

## Backoff Sequence

Approximate delays: 1s → 2s → 4s → 8s → 16s → 30s → 30s...

## Implementation

```typescript
function getReconnectDelay(retryCount: number): number {
  const baseDelay = Math.min(
    INITIAL_RETRY_DELAY * Math.pow(2, retryCount),
    MAX_RETRY_DELAY
  );
  const jitter = baseDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}
```

## Behavior

1. On disconnect, schedule reconnection with calculated delay
2. On successful connection, reset retry count to 0
3. On component unmount, cancel pending reconnection
