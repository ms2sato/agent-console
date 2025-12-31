# Terminal Worker Slow Startup Issue

**Date:** 2025-12-30
**Branch:** perf/optimize-terminal-log-rendering
**Status:** Root cause identified, fix pending

## Summary

New terminal workers take 15-37 seconds to become interactive, with the browser appearing frozen during this time. Investigation revealed that the root cause is excessive Terminal component re-mounting triggered by tab state updates.

## Problem Description

When creating a new Terminal Worker:
- User clicks "Add Terminal" button
- Browser appears frozen for 15-37 seconds
- Terminal eventually becomes interactive
- Chrome DevTools shows "Violation: 'message' handler took 17200ms"

## Investigation Timeline

### Initial Hypothesis: gzip Compression

Initially suspected that removing gzip compression from worker output files caused the slowdown. However, testing showed:
- Server-side WebSocket connection completes in ~2ms
- File I/O operations are fast (<10ms)
- The delay occurs entirely on the frontend

### Server-Side Performance Logs

```
Worker created: 10:27:54.948
WebSocket connection started: 10:28:10.372 (15.4 seconds later!)
WebSocket connection completed: 10:28:10.374 (Duration: 2.04ms)
```

**Conclusion:** Server-side is not the bottleneck.

### Frontend Performance Logs

Added detailed performance logging to trace the frontend flow:

**Timeline for new worker (workerId: 1e115a44-3c05-4b26-ac93-d71826010f50):**

```
11:00:47.867 - Worker creation API call started
11:00:48.007 - Worker creation API response received (140ms - OK)
11:00:48.007 - Tab added to state
11:00:48.007 - Active tab set
11:00:53.886 - Terminal component mounting (5.9 seconds later!)
11:01:05.615 - WebSocket connection starting (17.7 seconds later!)
11:01:25.191 - WebSocket connection established (37.3 seconds later!)
```

**Key Delays:**
1. Active tab set → Terminal mounting: **5.9 seconds**
2. Terminal mounting → WebSocket start: **11.7 seconds**
3. Total time to connection: **37.3 seconds**

## Root Cause: Excessive Component Re-mounting

The Terminal component for the new worker is mounted **7 times** during the startup process:

```
11:00:53.886 - Terminal component mounting (1st)
11:01:05.989 - Terminal component mounting (2nd)
11:01:12.460 - Terminal component mounting (3rd)
11:01:25.191 - Terminal component mounting (4th)
11:01:30.580 - Terminal component mounting (5th)
11:01:42.469 - Terminal component mounting (6th)
11:01:47.556 - Terminal component mounting (7th)
```

**Critical Finding:** Not only the new tab, but **ALL existing tabs** are also re-mounted with each state update.

### Example: All 5 workers remounting simultaneously

At `11:00:53.886-888`:
```
[Perf] 11:00:53.886 - 64d9c9f1 - Terminal component mounting
[Perf] 11:00:53.887 - 0c07c576 - Terminal component mounting
[Perf] 11:00:53.887 - 98c2adaf - Terminal component mounting
[Perf] 11:00:53.887 - 5c1fd484 - Terminal component mounting
[Perf] 11:00:53.887 - 1e115a44 - Terminal component mounting
```

This pattern repeats multiple times, causing cumulative rendering delays.

## Chrome DevTools Violations

```
[Violation] 'message' handler took 17200ms
[Violation] 'requestAnimationFrame' handler took 198ms
[Violation] Forced reflow while executing JavaScript took <N>ms
```

These violations indicate that JavaScript main thread is blocked by:
1. WebSocket message handling (processing history data)
2. DOM operations during rendering
3. Forced reflows during layout calculations

## Technical Details

### Tab Management Code Structure

**File:** `packages/client/src/routes/sessions/$sessionId.tsx`

When adding a new terminal tab:
```typescript
const newTab: Tab = {
  id: worker.id,
  workerType: 'terminal',
  name: worker.name,
};
setTabs(prev => [...prev, newTab]);  // This triggers re-render
setActiveTabId(worker.id);            // This triggers another re-render
```

### Terminal Component Rendering

**File:** `packages/client/src/components/Terminal.tsx`

Each Terminal component:
1. Mounts and initializes xterm.js
2. Establishes WebSocket connection
3. Loads history data
4. Renders terminal UI

When all tabs re-mount simultaneously:
- Multiple xterm.js instances initialize
- Multiple WebSocket connections establish
- Multiple history loads occur
- Multiple DOM updates happen

This creates a cascading delay effect.

## Detailed Logs

### Complete Frontend Log Sequence

<details>
<summary>Click to expand full log</summary>

```
[Perf] 2025-12-30T11:00:47.867Z - 5def336e-26c5-4db7-bea2-26f25c794526/temp-1767092447867 - Worker creation API call started
[Perf] 2025-12-30T11:00:48.007Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - Worker creation API response received
[Perf] 2025-12-30T11:00:48.007Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - Tab added to state
[Perf] 2025-12-30T11:00:48.007Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - Active tab set
[Perf] 2025-12-30T11:00:48.008Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - Terminal component mounting
[Perf] 2025-12-30T11:00:48.008Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:00:48.008Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:00:48.008Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:00:53.886Z - 5def336e-26c5-4db7-bea2-26f25c794526/64d9c9f1-69df-4ae5-a385-13ff0fe076c5 - Terminal component mounting
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/64d9c9f1-69df-4ae5-a385-13ff0fe076c5 - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/64d9c9f1-69df-4ae5-a385-13ff0fe076c5 - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/64d9c9f1-69df-4ae5-a385-13ff0fe076c5 - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/0c07c576-f8db-4c5c-a4d6-2e80099498b6 - Terminal component mounting
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/0c07c576-f8db-4c5c-a4d6-2e80099498b6 - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/0c07c576-f8db-4c5c-a4d6-2e80099498b6 - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/0c07c576-f8db-4c5c-a4d6-2e80099498b6 - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/98c2adaf-d8d3-4245-8814-12a81c53a96d - Terminal component mounting
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/98c2adaf-d8d3-4245-8814-12a81c53a96d - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/98c2adaf-d8d3-4245-8814-12a81c53a96d - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/98c2adaf-d8d3-4245-8814-12a81c53a96d - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/5c1fd484-05a2-41a4-92cc-cc60ee72b115 - Terminal component mounting
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/5c1fd484-05a2-41a4-92cc-cc60ee72b115 - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/5c1fd484-05a2-41a4-92cc-cc60ee72b115 - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/5c1fd484-05a2-41a4-92cc-cc60ee72b115 - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - Terminal component mounting
[Perf] 2025-12-30T11:00:53.887Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:00:53.888Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:00:53.888Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:01:05.615Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - WebSocket connection starting (via usePersistentWebSocket)
[Perf] 2025-12-30T11:01:05.615Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - WorkerWebSocket connect() called
[Perf] 2025-12-30T11:01:05.615Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - WorkerWebSocket creating new WebSocket
[Perf] 2025-12-30T11:01:05.989Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - Terminal component mounting
[Perf] 2025-12-30T11:01:05.991Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:01:05.991Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:01:05.991Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - useTerminalWebSocket hook initialized
[Violation] 'message' handler took <N>ms
[Violation] Forced reflow while executing JavaScript took <N>ms
[Violation] 'requestAnimationFrame' handler took 198ms
[Perf] 2025-12-30T11:01:06.919Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - Terminal component mounting
[Perf] 2025-12-30T11:01:06.919Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - useTerminalWebSocket hook initializing
[Perf] 2025-12-30T11:01:06.919Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - useTerminalWebSocket hook initializing (inside hook)
[Perf] 2025-12-30T11:01:06.920Z - 5def336e-26c5-4db7-bea2-26f25c794526/20d58c89-2e81-4fa0-a74b-62f04680dcaf - useTerminalWebSocket hook initialized
[Perf] 2025-12-30T11:01:25.191Z - 5def336e-26c5-4db7-bea2-26f25c794526/1e115a44-3c05-4b26-ac93-d71826010f50 - WorkerWebSocket connection established (onopen)
[WorkerWS] Connected: 5def336e-26c5-4db7-bea2-26f25c794526:1e115a44-3c05-4b26-ac93-d71826010f50
```

</details>

### Server-Side Logs

<details>
<summary>Click to expand server logs</summary>

```
{"level":30,"time":1767091674948,"pid":98146,"hostname":"GEMINI.local","service":"session-manager","workerId":"5c1fd484-05a2-41a4-92cc-cc60ee72b115","workerType":"terminal","sessionId":"5def336e-26c5-4db7-bea2-26f25c794526","msg":"Worker created"}
{"level":30,"time":1767091690372,"pid":98146,"hostname":"GEMINI.local","service":"websocket","sessionId":"5def336e-26c5-4db7-bea2-26f25c794526","workerId":"5c1fd484-05a2-41a4-92cc-cc60ee72b115","msg":"Worker WebSocket connection started"}
{"level":30,"time":1767091690373,"pid":98146,"hostname":"GEMINI.local","service":"websocket","sessionId":"5def336e-26c5-4db7-bea2-26f25c794526","workerId":"5c1fd484-05a2-41a4-92cc-cc60ee72b115","workerType":"terminal","msg":"Worker WebSocket connected"}
{"level":30,"time":1767091690373,"pid":98146,"hostname":"GEMINI.local","service":"websocket","sessionId":"5def336e-26c5-4db7-bea2-26f25c794526","workerId":"5c1fd484-05a2-41a4-92cc-cc60ee72b115","msg":"History loading started"}
{"level":30,"time":1767091690374,"pid":98146,"hostname":"GEMINI.local","service":"websocket","sessionId":"5def336e-26c5-4db7-bea2-26f25c794526","workerId":"5c1fd484-05a2-41a4-92cc-cc60ee72b115","durationMs":"0.75","msg":"History loading completed"}
{"level":30,"time":1767091690374,"pid":98146,"hostname":"GEMINI.local","service":"websocket","sessionId":"5def336e-26c5-4db7-bea2-26f25c794526","workerId":"5c1fd484-05a2-41a4-92cc-cc60ee72b115","workerType":"terminal","durationMs":"2.04","msg":"Worker WebSocket connection completed"}
```

**Key metrics:**
- Worker created to WebSocket start: 15.4 seconds
- WebSocket connection duration: 2.04ms

</details>

## Next Steps

1. **Optimize tab state management** to prevent unnecessary re-renders
   - Use React.memo() for Terminal components
   - Implement proper key props to maintain component identity
   - Consider using a keyed object/Map instead of array for tabs

2. **Implement lazy rendering** for inactive tabs
   - Only mount Terminal components for visible tabs
   - Use placeholder components for hidden tabs
   - Initialize WebSocket connections only when tab becomes active

3. **Add React DevTools profiling** to identify expensive renders
   - Profile component render times
   - Identify unnecessary re-renders
   - Measure impact of optimizations

4. **Consider architectural changes**
   - Move tab state to a more granular context
   - Separate active tab state from tab list state
   - Use refs to avoid re-renders when possible

## References

- Branch: `perf/optimize-terminal-log-rendering`
- Related files:
  - `packages/client/src/routes/sessions/$sessionId.tsx`
  - `packages/client/src/components/Terminal.tsx`
  - `packages/client/src/hooks/useTerminalWebSocket.ts`
  - `packages/client/src/lib/worker-websocket.ts`

## Additional Notes

- The gzip compression removal is **not** the cause of this issue
- Server-side performance is excellent (2ms for WebSocket setup)
- The issue scales with the number of existing tabs
- Chrome DevTools violations confirm JavaScript main thread blocking
