# Terminal Conditional Rendering Design

## Why This Change?

### The Problem We're Solving

In the current implementation, all Terminal components remain mounted even when their tabs are hidden (using `display: none`). This causes:

- Memory usage grows with the number of tabs
- Hidden terminals keep xterm.js instances in memory
- The `isVisible` prop adds complexity to the code

### What We Want to Achieve

With conditional rendering, **only the active tab's Terminal is mounted**. Hidden tabs are completely unmounted, and when shown again, history is fetched from the server to restore the content.

```tsx
// Before: display: none (all mounted)
<div style={{ display: isActive ? 'flex' : 'none' }}>
  <Terminal isVisible={isActive} />
</div>

// After: conditional rendering (only active mounted)
{isActive && <Terminal />}
```

### Key Insight: WebSocket is Already Singleton

This design works because WebSocket connections are managed as singletons in `worker-websocket.ts`. When a Terminal unmounts, the WebSocket stays open, and the server continues buffering output. When the Terminal remounts, it fetches the full history including any output that occurred while hidden.

---

## Design Principles

### 1. Trust the Server

Instead of maintaining and calculating history diffs on the client, fetch the full history from the server every time. This keeps client state management simple and prevents inconsistencies with the server.

### 2. Minimize State

The Terminal component should only have two pieces of state: `isMounted` and `pendingHistory`. Adding more state increases complexity and creates bugs.

### 3. Prepare for Race Conditions

History may arrive before xterm.js is initialized. The probability is low, but we use `pendingHistory` to temporarily store data when it happens.

---

## What Happens When User Switches Tabs

This is the most important part to understand. If this works correctly, the design is successful.

### Switching from Tab A to Tab B

```
1. User clicks Tab B
2. SessionPage: setActiveTabId("worker-b")

--- Terminal A Unmount ---
3. React: Execute Terminal A's cleanup
4. stateRef = { isMounted: false, pendingHistory: null }
5. xterm.js.dispose() - terminal instance destroyed
6. Note: WebSocket is NOT closed (singleton)
7. Note: Server continues buffering output for worker-a

--- Terminal B Mount ---
8. React: Execute Terminal B's useEffect
9. Create new xterm.js, attach to DOM
10. stateRef.isMounted = true
11. usePersistentWebSocket calls connect()
12. Finds existing OPEN connection → schedules request-history (100ms debounce)
13. Server responds with full history
14. handleHistory() writes to xterm.js
15. Terminal B is fully operational
```

### When Claude is Working in a Hidden Tab

```
Tab B is active, Tab A (Claude) is hidden

1. Claude generates output in worker-a
2. Server sends 'output' message via WebSocket
3. worker-websocket receives it, calls handleOutput callback
4. But Terminal A is unmounted, terminalRef.current = null
5. Output is NOT written to any xterm.js
6. Output is buffered on the server

--- User switches back to Tab A ---
7. Terminal A mounts
8. request-history fetches full history from server
9. All content including what Claude did while hidden is displayed
```

**Important**: Output is not "lost" - it's buffered on the server. That's why it can be restored when switching back.

---

## State Management

### Why Remove `lastHistoryData`?

The current implementation stores `lastHistoryData` in `worker-websocket.ts` for diff calculation:

```typescript
// Current implementation
const lastHistoryData = workerWs.getLastHistoryData(sessionId, workerId);
const update = calculateHistoryUpdate(lastHistoryData, data);
if (update.type === 'diff') {
  terminal.write(update.newData);  // Write only the diff
}
```

**Why this breaks with conditional rendering:**

1. Show Tab A, receive history "ABC", `lastHistoryData = "ABC"`
2. Switch to Tab B, Terminal A unmounts, **xterm.js is destroyed**
3. Switch back to Tab A, Terminal A remounts, **xterm.js is empty**
4. Receive history "ABCDE"
5. `lastHistoryData = "ABC"` still exists, so only diff "DE" is written
6. **Result: Empty xterm.js shows only "DE" → broken display**

**Solution**: Remove `lastHistoryData` and always write the full history. Simple and reliable.

### The `stateRef` Design

```typescript
interface TerminalState {
  isMounted: boolean;           // Is xterm.js initialized?
  pendingHistory: string | null; // History that arrived before xterm.js was ready
}

const stateRef = useRef<TerminalState>({
  isMounted: false,
  pendingHistory: null,
});
```

**Why useRef instead of useState:**
- These values don't affect UI rendering
- Need synchronous access/update from callbacks
- Avoid unnecessary re-renders

### Handling the Race Condition

History may arrive before xterm.js is initialized (low probability):

```typescript
const handleHistory = useCallback((data: string) => {
  if (!stateRef.current.isMounted) {
    // xterm.js not ready yet → store temporarily
    stateRef.current.pendingHistory = data;
    return;
  }
  // xterm.js is ready → write
  writeFullHistory(terminalRef.current!, data);
}, []);

// When xterm.js initializes
useEffect(() => {
  const terminal = new XTerm({ ... });
  terminal.open(container);
  terminalRef.current = terminal;
  stateRef.current.isMounted = true;

  // Process stored history if any
  if (stateRef.current.pendingHistory) {
    writeFullHistory(terminal, stateRef.current.pendingHistory);
    stateRef.current.pendingHistory = null;
  }

  return () => {
    stateRef.current = { isMounted: false, pendingHistory: null };
    terminal.dispose();
  };
}, []);
```

---

## Files to Change

### packages/client/src/lib/worker-websocket.ts

**Remove:**
- `lastHistoryData` field from `WorkerConnection`
- `getLastHistoryData()` function
- `setLastHistoryData()` function
- `lastHistoryData` preservation logic in `reconnect()`

**Reason:** Diff calculation is no longer needed.

### packages/client/src/components/Terminal.tsx

**Add:**
- `TerminalState` interface and `stateRef`
- `isMounted` check and `pendingHistory` handling in `handleHistory`
- `pendingHistory` processing in xterm.js initialization effect

**Remove:**
- `hasLoadedHistory` state
- Dependency on `isVisible` prop
- `lastHistoryData` get/set calls
- `calculateHistoryUpdate` usage

**Change:**
- `handleHistory`: Always write full history instead of calculating diffs

### packages/client/src/routes/sessions/$sessionId.tsx

**Change:**
- From rendering all tabs with `display: none` → render only active tab conditionally
- Remove `isVisible` prop
- Add `key={activeTab.id}` to ensure remount on tab switch

### packages/client/src/lib/terminal-history-utils.ts

**Delete:** Remove the entire file. `calculateHistoryUpdate` is no longer needed.

---

## Implementation Phases

### Phase 1: Update Terminal State Management

**Goal:** Change state management to support conditional rendering

**Tasks:**
1. Add `stateRef` with `isMounted` and `pendingHistory`
2. Update `handleHistory` to check `isMounted` and handle `pendingHistory`
3. Set `isMounted` and process `pendingHistory` in xterm.js initialization effect

**At this point:**
- `lastHistoryData` still exists (unused but harmless)
- `isVisible` prop still exists
- Existing behavior should be unchanged

**Verification:**
- Existing tests pass
- Tab switching works normally

### Phase 2: Change SessionPage to Conditional Rendering

**Goal:** Actually enable conditional rendering

**Tasks:**
1. Change from `display: none` to conditional rendering
2. Remove `isVisible` prop
3. Add `key={activeTab.id}`

**Verification:**
- History is correctly restored on tab switch
- Content from Claude working in hidden tab is displayed when switching back
- Fast tab switching doesn't cause issues

### Phase 3: Cleanup

**Goal:** Remove code that's no longer needed

**Tasks:**
1. Remove `lastHistoryData` related code from `worker-websocket.ts`
2. Delete `terminal-history-utils.ts`
3. Remove unused imports from Terminal.tsx
4. Remove debug logs

**Verification:**
- All tests pass
- No TypeScript build errors

---

## How to Verify Success

### Basic Operation

1. Show Tab A (Claude)
2. Switch to Tab B (Shell)
3. Switch back to Tab A
4. **Expected:** Tab A content is fully displayed

### Output While Hidden

1. Show Tab A (Claude), have Claude do some work
2. While Claude is working, switch to Tab B
3. Wait a while (Claude continues working)
4. Switch back to Tab A
5. **Expected:** All output from Claude while hidden is displayed

### Fast Switching

1. Rapidly switch between Tab A and Tab B multiple times
2. **Expected:** Correct tab content is displayed, no errors

### Memory Usage (Optional)

1. Open many tabs
2. Check memory usage in Chrome DevTools
3. **Expected:** Lower usage than display: none approach

---

## Edge Cases to Consider

### History Arrives Before xterm.js Initialization

**Situation:** Network is very fast, or xterm.js initialization is slow

**Handling:** Store in `pendingHistory`, process after initialization. Built into the design.

### Tab Switch During History Reception

**Situation:** User switches tabs while receiving large history

**Handling:** Reset `stateRef` on unmount. Request new history on next mount.

### WebSocket Reconnection

**Situation:** Reconnection after network disconnect

**Handling:** Existing reconnection logic works. After reconnect, `connect()` is called and history is requested.

---

## What This Design Does NOT Do

Explicitly out of scope:

1. **Scroll position preservation** - Always starts from bottom. Could be a future enhancement.
2. **History caching** - Always fetches from server. Consider if bandwidth becomes an issue.
3. **WebSocket disconnection** - Keeps connection even for hidden tabs. Different design needed for resource reduction.

---

## Troubleshooting Guide

Points to check when issues occur during implementation:

### History Not Displayed

1. Check if `stateRef.current.isMounted` becomes true
2. Check if `handleHistory` is called (console.log)
3. Check if `pendingHistory` has a value that wasn't processed

### Duplicate History Display

1. Check if `handleHistory` calls `terminal.clear()` before writing
2. Check if `lastHistoryData` still exists (should be removed)

### Errors on Tab Switch

1. Check if accessing `terminalRef.current` when it's null
2. Check if callbacks are called after unmount
