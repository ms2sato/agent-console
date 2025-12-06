# Agent Abstraction Implementation Plan

## Goal
Claude Code固定のコードをAgent抽象化層に分離し、UIからAgentを登録・選択できるようにする。

## Requirements
- Claude Codeのみ対応（まず分離）
- Agent設定はUIから登録（永続化）
- Activity検知: レート検知ベースライン + オプショナルなパターン

---

## Phase 1: Shared Type Definitions

### 1.1 Create Agent Types
**New file**: `packages/shared/src/types/agent.ts`
```typescript
export interface AgentDefinition {
  id: string;
  name: string;
  command: string;
  description?: string;
  icon?: string;
  isBuiltIn: boolean;
  registeredAt: string;
  activityPatterns?: AgentActivityPatterns;
}

export interface AgentActivityPatterns {
  askingPatterns?: string[];  // Regex patterns as strings
}

export interface CreateAgentRequest {
  name: string;
  command: string;
  description?: string;
  icon?: string;
  activityPatterns?: AgentActivityPatterns;
}
```

### 1.2 Update Shared Index
**Modify**: `packages/shared/src/index.ts`
- Export agent types
- Add `agentId?: string` to `Session`, `CreateSessionRequest`, `CreateWorktreeRequest`

---

## Phase 2: Server Services

### 2.1 Update PersistenceService
**Modify**: `packages/server/src/services/persistence-service.ts`
- Add `PersistedAgent` interface
- Add `loadAgents()` / `saveAgents()` methods
- Store in `~/.agents-web-console/agents.json`

### 2.2 Create AgentManager Service
**New file**: `packages/server/src/services/agent-manager.ts`
- `CLAUDE_CODE_AGENT_ID = 'claude-code-builtin'`
- Built-in Claude Code with ASKING_PATTERNS (extracted from activity-detector.ts)
- `registerAgent()`, `updateAgent()`, `unregisterAgent()`, `getAgent()`, `getAllAgents()`
- Built-in agents cannot be deleted

### 2.3 Refactor ActivityDetector
**Modify**: `packages/server/src/services/activity-detector.ts`
- Remove hardcoded `ASKING_PATTERNS`
- Accept `activityPatterns?: AgentActivityPatterns` in constructor options
- If no patterns provided, skip pattern-based detection (rate-based only)

### 2.4 Update SessionManager
**Modify**: `packages/server/src/services/session-manager.ts`
- Import `agentManager`
- `createSession()` accepts optional `agentId` parameter
- Resolve agent definition and spawn `agent.command`
- Pass `agent.activityPatterns` to ActivityDetector
- Store `agentId` in session and persistence

---

## Phase 3: API Endpoints

### 3.1 Add Agents API
**Modify**: `packages/server/src/routes/api.ts`
```
GET    /api/agents          - List all agents
GET    /api/agents/:id      - Get single agent
POST   /api/agents          - Register new agent
PATCH  /api/agents/:id      - Update agent
DELETE /api/agents/:id      - Unregister agent (built-in blocked)
```

### 3.2 Update Session/Worktree APIs
- `POST /api/sessions` - Accept `agentId` in body
- `POST /api/repositories/:id/worktrees` - Accept `agentId` for autoStartSession

---

## Phase 4: Client Changes

### 4.1 Add Agents API Functions
**Modify**: `packages/client/src/lib/api.ts`
- `fetchAgents()`, `registerAgent()`, `updateAgent()`, `unregisterAgent()`
- Update `createSession()` to accept `agentId`

### 4.2 Create AgentSelector Component
**New file**: `packages/client/src/components/AgentSelector.tsx`
- Dropdown showing all registered agents
- Default to first agent (Claude Code)

### 4.3 Create AgentManagement Component
**New file**: `packages/client/src/components/AgentManagement.tsx`
- List registered agents
- Add new agent form (name, command, description, icon)
- Delete button (disabled for built-in)

### 4.4 Update Dashboard UI
**Modify**: `packages/client/src/routes/index.tsx`
- Add Settings section with AgentManagement
- Add AgentSelector to:
  - RepositoryCard worktree creation form
  - WorktreeRow session start
  - QuickSessionsSection form

---

## Implementation Order

```
Step 1: packages/shared/src/types/agent.ts (new)
Step 2: packages/shared/src/index.ts (update exports & types)
Step 3: packages/server/src/services/persistence-service.ts (add agents)
Step 4: packages/server/src/services/agent-manager.ts (new)
Step 5: packages/server/src/services/activity-detector.ts (refactor)
Step 6: packages/server/src/services/session-manager.ts (integrate)
Step 7: packages/server/src/routes/api.ts (add endpoints)
Step 8: packages/client/src/lib/api.ts (add functions)
Step 9: packages/client/src/components/AgentSelector.tsx (new)
Step 10: packages/client/src/components/AgentManagement.tsx (new)
Step 11: packages/client/src/routes/index.tsx (integrate)
```

---

## Critical Files

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types/agent.ts` | Create | Agent type definitions |
| `packages/shared/src/index.ts` | Modify | Export types, add agentId fields |
| `packages/server/src/services/persistence-service.ts` | Modify | Add agents persistence |
| `packages/server/src/services/agent-manager.ts` | Create | Agent CRUD service |
| `packages/server/src/services/activity-detector.ts` | Modify | Injectable patterns |
| `packages/server/src/services/session-manager.ts` | Modify | Use AgentManager |
| `packages/server/src/routes/api.ts` | Modify | Agents API endpoints |
| `packages/client/src/lib/api.ts` | Modify | Agents API client |
| `packages/client/src/components/AgentSelector.tsx` | Create | Agent dropdown |
| `packages/client/src/components/AgentManagement.tsx` | Create | Agent settings UI |
| `packages/client/src/routes/index.tsx` | Modify | Integrate agent selection |

---

## Testing Checklist

- [ ] Claude Code auto-registered on fresh install
- [ ] Built-in agents cannot be deleted
- [ ] Custom agents can be added/removed via UI
- [ ] Sessions without agentId default to Claude Code
- [ ] Activity detection works with patterns (Claude) and without (custom)
- [ ] Agent selection appears in worktree creation
- [ ] Agent selection appears in quick start
