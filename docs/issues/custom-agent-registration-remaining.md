# Custom Agent Registration - Remaining Issues

This document tracks issues identified during code review of the custom agent registration feature (`feat/custom-agent-registration` branch).

## Status: Review Complete, Issues Documented

Date: 2024-12-17

---

## Critical Issues

### 1. Missing Test Coverage for Agent WebSocket Events

**Location**: `packages/client/src/hooks/__tests__/useAppWs.test.ts`

**Problem**: No tests exist for the new agent-related event handlers (`onAgentsSync`, `onAgentCreated`, `onAgentUpdated`, `onAgentDeleted`), even though session event handlers are thoroughly tested.

**Impact**:
- Regression risk when modifying agent WebSocket handling
- Cannot verify that agent events properly trigger callbacks

**Fix**:
```typescript
it('should call onAgentsSync for agents-sync message', () => {
  const onAgentsSync = mock(() => {});
  renderHook(() => useAppWsEvent({ onAgentsSync }));

  const ws = MockWebSocket.getLastInstance();
  act(() => {
    ws?.simulateOpen();
    ws?.simulateMessage(JSON.stringify({ type: 'agents-sync', agents: [] }));
  });

  expect(onAgentsSync).toHaveBeenCalled();
});
```

---

### 2. No Component Tests for AgentManagement.tsx

**Location**: `packages/client/src/components/AgentManagement.tsx`

**Problem**: Per testing-guidelines.md section "Form Component Testing", schema unit tests alone are insufficient. Missing tests for:
- Form submission with valid/invalid data
- "Add Agent" button enabling/disabling
- Advanced settings toggle behavior
- Error display from server (409 conflict dialog)
- Loading states during mutations
- Comma-separated askingPatterns parsing

**Impact**:
- Form validation behavior not verified
- Error handling not tested
- Regression risk for UI changes

**Fix**: Create `packages/client/src/components/__tests__/AgentManagement.test.tsx`

---

### 3. Race Condition in Cache Updates

**Location**: `packages/client/src/components/AgentManagement.tsx:66` and `packages/client/src/routes/index.tsx:215-245`

**Problem**: The code uses both REST API mutations with `invalidateQueries` AND WebSocket event handlers that update the cache. This creates a race condition:
1. User creates agent via REST API
2. Server broadcasts `agent-created` via WebSocket
3. Client receives REST response and calls `invalidateQueries`
4. Client also receives WebSocket event and updates cache

Both updates can arrive in any order, potentially causing duplicate data or lost updates.

**Impact**:
- UI may show duplicate agents temporarily
- Agent list may not reflect the latest state

**Fix**: Remove `invalidateQueries` from mutation success handlers - rely solely on WebSocket events for cache updates:
```typescript
// AgentManagement.tsx
const registerMutation = useMutation({
  mutationFn: registerAgent,
  onSuccess: () => {
    onSuccess(); // Don't call invalidateQueries - WebSocket handles it
  },
});
```

---

### 4. Missing agentsSynced Flag

**Location**: `packages/client/src/lib/app-websocket.ts`

**Problem**: Sessions have a `sessionsSynced` flag that Dashboard waits for before rendering. Agents have no equivalent flag, so the UI might show empty agents list during initial load.

**Impact**:
- User may see empty agents list briefly on page load
- Inconsistent behavior compared to sessions

**Fix**: Add `agentsSynced` tracking similar to sessions:
```typescript
// app-websocket.ts
let agentsSynced = false;

// Export getter
export function areAgentsSynced(): boolean {
  return agentsSynced;
}

// Set to true when agents-sync received
```

---

## High Priority Issues

### 5. No WebSocket Disconnection Indicator

**Location**: `packages/client/src/routes/index.tsx`

**Problem**: When WebSocket disconnects, users have no visual feedback. They might continue working without knowing real-time updates are not arriving.

**Impact**:
- User doesn't know if real-time updates are working
- Might create agent in another tab and not see it appear
- No warning that data might be stale

**Fix**: Add connection status indicator:
```typescript
const { connected } = useAppWsState();

return (
  <>
    {!connected && (
      <Banner variant="warning">
        Real-time updates disconnected. Reconnecting...
      </Banner>
    )}
    {/* rest of component */}
  </>
);
```

---

### 6. Inconsistent Error Handling in AddAgentForm

**Location**: `packages/client/src/components/AgentManagement.tsx:185-207`

**Problem**: The form's `onSubmit` catches errors and sets them via `setError('root', ...)`, but the mutation could also handle errors via `onError`. Two error paths exist with no coordination.

**Impact**:
- Users may not see error messages for certain API failures
- Network errors vs. validation errors handled inconsistently

**Fix**: Consolidate to mutation's onError:
```typescript
const registerMutation = useMutation({
  mutationFn: registerAgent,
  onSuccess: () => onSuccess(),
  onError: (error) => {
    setError('root', {
      message: error instanceof Error ? error.message : 'Failed to register agent',
    });
  },
});

const onSubmit = async (data: AddAgentFormData) => {
  // Just call mutateAsync, let onError handle failures
  await registerMutation.mutateAsync(transformedData);
};
```

---

## Medium Priority Issues

### 7. Type Safety Issue with askingPatternsInput

**Location**: `packages/client/src/components/AgentManagement.tsx:169-172, 188-191`

**Problem**: The form field `askingPatternsInput` is not validated by Valibot schema. Parsing logic (split by comma, trim) is in component, not in schema.

**Impact**:
- Users can submit empty patterns ("  ,  ,  ") which pass validation
- Inconsistent behavior if server-side parsing differs

**Fix**: Create dedicated form schema with transform:
```typescript
const AddAgentFormSchema = v.object({
  // ... other fields
  askingPatternsInput: v.optional(v.string()),
});

// Transform in onSubmit before API call
```

---

### 8. AgentSelector May Not Reflect Real-Time Changes

**Location**: `packages/client/src/components/AgentSelector.tsx`

**Problem**: If AgentSelector dropdown is open when a new agent is created in another tab, the dropdown might not update.

**Impact**:
- User may not see newly created agents in selector
- Requires closing and reopening dropdown

**Fix**: Add refetch on window focus or subscribe to agent events at app root level.

---

### 9. Missing 409 Conflict Test in Client API Tests

**Location**: `packages/client/src/lib/__tests__/api.test.ts`

**Problem**: No test for parsing 409 conflict error response with session names.

**Fix**:
```typescript
it('should parse 409 conflict error with session list', async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 409,
    json: () => Promise.resolve({
      error: 'Agent is in use by 2 session(s): Session A, Session B'
    }),
  });

  await expect(unregisterAgent('agent-1')).rejects.toThrow('in use by 2 session');
});
```

---

### 10. Capability Computation Edge Cases Not Tested

**Location**: `packages/shared/src/schemas/__tests__/agent.test.ts`

**Problem**: Missing tests for:
- `continueTemplate: "   "` (whitespace-only should be `supportsContinue: false`)
- `activityPatterns: { askingPatterns: ["", "  "] }` (all empty should be `supportsActivityDetection: false`)

**Fix**: Add edge case tests in agent.test.ts

---

## Low Priority Issues

### 11. Missing Error Boundary for AgentManagement

**Location**: `packages/client/src/routes/index.tsx:442-445`

**Problem**: AgentManagement is rendered without error boundary. A bug could crash the entire dashboard.

**Fix**: Wrap in ErrorBoundary component.

---

### 12. Form Validation UX (onBlur vs onChange)

**Location**: `packages/client/src/components/AgentManagement.tsx:191`

**Problem**: Form uses `mode: 'onBlur'`, so users don't get immediate feedback while typing. For technical fields like `{{prompt}}` placeholders, this creates poor UX.

**Fix**: Consider `mode: 'onChange'` for immediate feedback.

---

### 13. Missing Defensive Checks for Capabilities

**Location**: `packages/client/src/components/AgentManagement.tsx:114`

**Problem**: Component trusts that `agent.capabilities` exists. If server returns malformed data, UI breaks.

**Fix**: Add defensive fallback:
```typescript
const capabilities = agent.capabilities ?? {
  supportsContinue: false,
  supportsHeadlessMode: false,
  supportsActivityDetection: false,
};
```

---

## Positive Observations (No Action Needed)

1. **409 Conflict error display**: Properly implemented via ErrorDialog
2. **Server protects in-use agents**: Both active and inactive sessions checked
3. **WebSocket message ordering**: Sync messages sent before joining broadcast list
4. **Built-in agent protection**: Cannot delete or modify built-in agents
5. **Automatic reconnection**: Robust exponential backoff with jitter
6. **Capability indicators in UI**: Good UX showing agent features

---

## Recommended Priority Order

1. **Critical (Before Merge)**:
   - #3 Race condition fix (remove invalidateQueries)
   - #1 WebSocket event tests
   - #2 AgentManagement component tests

2. **High (Soon After Merge)**:
   - #4 agentsSynced flag
   - #5 WebSocket disconnection indicator
   - #6 Consolidate error handling

3. **Medium (Technical Debt)**:
   - #7-#10 Various improvements

4. **Low (Nice to Have)**:
   - #11-#13 Polish items
