# IndexedDB Save Timing Issue

**Date:** 2025-01-24
**Branch:** chore/audit-indexdb-save-timing
**Status:** ✅ Resolved (2026-01-24)

## Summary

Terminal state caching to IndexedDB uses fire-and-forget patterns that can result in data loss during page reload or navigation. The async save operations are not awaited, and there is no protection mechanism for page unload events.

## Problem Description

The terminal state cache (`packages/client/src/lib/terminal-state-cache.ts`) is designed to store terminal state in IndexedDB for instant restore on tab switch. However, the current implementation has timing issues that can cause data loss.

### Core Issues

1. **Fire-and-forget saves**: All `saveTerminalState()` calls use `.catch()` without awaiting completion
2. **No page unload protection**: No `beforeunload` handler to flush pending saves
3. **Live output not cached**: `handleOutput` updates offset but does not trigger state save
4. **Unmount cleanup does not wait**: Component cleanup fires save but proceeds immediately

## Affected Code

### Terminal.tsx - Save Points

| Location | Trigger | Issue |
|----------|---------|-------|
| Line 128 | After output handler | Fire-and-forget |
| Line 164 | After full history restore | Fire-and-forget |
| Line 176 | After diff history (from cache) | Fire-and-forget |
| Line 181 | After diff history (fresh connection) | Fire-and-forget |
| Line 210 | After sending pending input | Fire-and-forget |
| Line 541-547 | Component unmount | **Not awaited** |

### Example of Fire-and-Forget Pattern

```typescript
// Terminal.tsx:541-547 (unmount cleanup)
return () => {
  saveTerminalState(sessionId, workerId, {
    data: serializedData,
    savedAt: Date.now(),
    cols: terminal.cols,
    rows: terminal.rows,
    offset: offsetRef.current,
  }).catch((e) => console.warn('[Terminal] Failed to save...', e))
  // Component cleanup continues immediately without waiting
}
```

### terminal-state-cache.ts

```typescript
// Line 60-71
export async function saveTerminalState(
  sessionId: string,
  workerId: string,
  state: TerminalCacheState,
): Promise<void> {
  const key = makeKey(sessionId, workerId);
  await set(key, state);  // This is async, but callers don't await
}
```

## Data Loss Scenarios

### High Risk

| Scenario | Cause | Result |
|----------|-------|--------|
| Page reload during output | Save promise pending when unload fires | State reverts to last successful save |
| Close tab during active session | No unload protection | All unsaved state lost |
| Rapid tab switching | Concurrent saves may conflict | Unpredictable state |

### Medium Risk

| Scenario | Cause | Result |
|----------|-------|--------|
| Browser crash | Pending IndexedDB transaction lost | State from last completed save |
| High-frequency output | No save during live output | Stale offset on reload |

## Implementation Plan

### Design Goals

1. Eliminate fire-and-forget patterns
2. Add idle-based save (1 minute) without performance impact
3. Best-effort protection against page unload

### Architecture: Global Save Manager

A singleton `TerminalStateSaveManager` will track all pending saves:

- `beforeunload` is global; needs access to all pending saves
- Follows existing pattern in `worker-websocket.ts` (global connection map)
- Enables coordinated flush across all terminals

### New Module: `terminal-state-save-manager.ts`

```typescript
// packages/client/src/lib/terminal-state-save-manager.ts

interface WorkerSaveState {
  isDirty: boolean;
  idleTimeout: ReturnType<typeof setTimeout> | null;
  pendingSave: Promise<void> | null;
  getState: () => CachedState | null;
}

const IDLE_SAVE_DELAY_MS = 60_000; // 1 minute

// Singleton API
register(sessionId, workerId, getStateCallback): void
unregister(sessionId, workerId): Promise<void>  // Saves before unregister
markDirty(sessionId, workerId): void  // Resets 1-min idle timer
flush(): Promise<void>  // Save all dirty terminals
hasPendingSaves(): boolean
```

### Terminal.tsx Changes

**Mount**: Register with save manager
```typescript
const stateGetter = () => {
  if (!terminalRef.current || !serializeAddonRef.current) return null;
  return {
    data: serializeAddonRef.current.serialize(),
    savedAt: Date.now(),
    cols: terminalRef.current.cols,
    rows: terminalRef.current.rows,
    offset: offsetRef.current,
  };
};
TerminalStateSaveManager.register(sessionId, workerId, stateGetter);
```

**handleOutput**: Replace fire-and-forget with markDirty
```typescript
const handleOutput = useCallback((data: string, offset: number) => {
  offsetRef.current = offset;
  terminalRef.current?.write(data, () => {
    updateScrollButtonVisibility();
  });
  TerminalStateSaveManager.markDirty(sessionId, workerId);
}, [sessionId, workerId, updateScrollButtonVisibility]);
```

**Cleanup**: Use unregister instead of direct save
```typescript
return () => {
  TerminalStateSaveManager.unregister(sessionId, workerId)
    .catch(e => console.warn('[Terminal] Failed to save on unmount:', e));
  // Remove direct saveTerminalState call
  // ... rest of cleanup unchanged ...
};
```

### main.tsx: beforeunload Handler

```typescript
import { TerminalStateSaveManager } from './lib/terminal-state-save-manager';

window.addEventListener('beforeunload', () => {
  if (TerminalStateSaveManager.hasPendingSaves()) {
    TerminalStateSaveManager.flush();
    // Note: Cannot await - best effort only
  }
});
```

### Idle Save Logic

```
Output received → markDirty() → Reset 1-min timer
                                    ↓ (after 1 min)
                              Get state via callback
                                    ↓
                              saveTerminalState() (awaited)
                                    ↓
                              Clear dirty flag
```

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Tab switch before timer | Unmount triggers immediate save via unregister |
| Rapid output | Timer keeps resetting, save deferred |
| Page reload | beforeunload attempts flush (best-effort) |
| Rapid tab switching | Track in-flight saves, await before new save |

## Constraints & Limitations

- IndexedDB has no synchronous API
- `beforeunload` cannot wait for async operations
- Some data loss possible if reload happens within 1 minute of last output
- Acceptable per requirement: "ゆるい保存で十分"

## Files to Modify

| File | Changes |
|------|---------|
| `packages/client/src/lib/terminal-state-save-manager.ts` | **NEW**: Save manager singleton |
| `packages/client/src/lib/__tests__/terminal-state-save-manager.test.ts` | **NEW**: Unit tests |
| `packages/client/src/components/Terminal.tsx` | Use save manager instead of direct saves |
| `packages/client/src/main.tsx` | Add beforeunload handler |

## Implementation Order

1. Create `TerminalStateSaveManager` with registration, dirty tracking, idle timer
2. Add unit tests for save manager
3. Modify `Terminal.tsx` to use save manager
4. Add beforeunload handler in `main.tsx`
5. Integration testing
6. Update this document status

## Verification

### Unit Tests
- Save manager registration/unregistration
- markDirty triggers idle timer
- flush() saves all dirty workers
- Concurrent save handling

### Manual Testing
1. Wait 1 minute after output, verify save occurs (check IndexedDB in DevTools)
2. Switch tabs, verify cache works on return
3. Reload page during idle, verify state restored
4. Rapid tab switching, verify no errors

### Commands
```bash
bun run test
bun run typecheck
```

## Resolution

### Implementation Summary

The fix was implemented as planned with the following changes:

| File | Change |
|------|--------|
| `packages/client/src/lib/terminal-state-save-manager.ts` | **NEW**: Save manager singleton with idle-based timing |
| `packages/client/src/lib/__tests__/terminal-state-save-manager.test.ts` | **NEW**: Unit tests (12 test cases) |
| `packages/client/src/components/Terminal.tsx` | Uses save manager instead of fire-and-forget saves |
| `packages/client/src/main.tsx` | Added beforeunload handler for best-effort flush |

### How It Works

1. **Registration**: On mount, `Terminal.tsx` registers a state getter callback with the save manager
2. **Dirty tracking**: When output is received, `markDirty()` is called instead of immediate saves
3. **Idle save**: After 1 minute of no new output, the save manager triggers a save
4. **Unmount save**: On cleanup, `unregister()` triggers an immediate save if dirty
5. **Page unload**: `beforeunload` handler calls `flush()` as a best-effort protection

### Test Results

All tests pass:
- `TerminalStateSaveManager`: 12 new test cases covering registration, dirty tracking, idle timer, flush, and edge cases
- Existing terminal tests: All passing
- Type check: Clean

### Limitations (Accepted)

- `beforeunload` cannot await async operations - IndexedDB writes are best-effort
- Some data loss possible if page reloads within 1 minute of last output
- Acceptable per requirement: "ゆるい保存で十分"

## References

- Design doc: `docs/design/terminal-state-sync.md`
- Cache implementation: `packages/client/src/lib/terminal-state-cache.ts`
- Save manager: `packages/client/src/lib/terminal-state-save-manager.ts`
- Terminal component: `packages/client/src/components/Terminal.tsx`
- Pattern reference: `packages/client/src/lib/worker-websocket.ts` (singleton with Map)
- idb-keyval library: Used for IndexedDB abstraction (v6.2.2)
