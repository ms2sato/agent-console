# Agent Management Pages Design

## Overview

Separate AgentManagement from dashboard into dedicated pages providing full CRUD operations.

## Files to Change

### New Files
1. `packages/client/src/routes/agents/index.tsx` - Agent list page
2. `packages/client/src/routes/agents/$agentId/index.tsx` - Agent detail page
3. `packages/client/src/routes/agents/$agentId/edit.tsx` - Agent edit page
4. `packages/client/src/components/agents/AgentForm.tsx` - Create/edit form component

### Modified Files
1. `packages/client/src/routes/index.tsx` - Remove AgentManagement
2. `packages/client/src/routes/__root.tsx` - Add Agents link to header

### Files to Delete
1. `packages/client/src/components/AgentManagement.tsx` - After migration

## Implementation Details

### 1. Agent List Page (`/agents`)

```
+-------------------------------------------------------------+
| Agent Console > Agents                      [+ Add Agent]   |
+-------------------------------------------------------------+
| +----------------------------------------------------------+|
| | Claude Code                              [built-in]      ||
| | claude {{prompt}}                                        ||
| | V Continue  V Headless  V Activity Detection             ||
| |                                              [View]      ||
| +----------------------------------------------------------+|
| +----------------------------------------------------------+|
| | Aider                                                    ||
| | aider --yes -m {{prompt}}                                ||
| | X Continue  X Headless  X Activity Detection             ||
| |                                    [Edit] [Delete]       ||
| +----------------------------------------------------------+|
+-------------------------------------------------------------+
```

Features:
- Agent list display (name, command, capabilities)
- Inline add agent form (toggle)
- Link to detail page
- Edit/Delete for custom agents

### 2. Agent Detail Page (`/agents/:agentId`)

```
+-------------------------------------------------------------+
| Agent Console > Agents > Aider              [Edit] [Delete] |
+-------------------------------------------------------------+
| Name: Aider                                                 |
| Description: GPT/Claude pair programming tool               |
|                                                             |
| -- Templates --------------------------------------------- |
| Command:   aider --yes -m {{prompt}}                        |
| Continue:  (not set)                                        |
| Headless:  (not set)                                        |
|                                                             |
| -- Activity Detection ------------------------------------ |
| Asking Patterns: (none)                                     |
|                                                             |
| -- Capabilities ------------------------------------------ |
| X Continue  X Headless  X Activity Detection               |
|                                                             |
| -- Metadata ---------------------------------------------- |
| ID: abc123-def456                                           |
| Registered: 2024-01-15 10:30:00                             |
+-------------------------------------------------------------+
```

Features:
- Read-only display of all settings
- Edit button -> navigate to edit page (`/agents/:id/edit`)
- Delete button -> confirmation dialog
- Hide Edit/Delete buttons for built-in agents

### 3. Agent Edit Page (`/agents/:agentId/edit`)

```
+-------------------------------------------------------------+
| Agent Console > Agents > Aider > Edit                       |
+-------------------------------------------------------------+
| Name:        [Aider                            ]            |
| Description: [GPT/Claude pair programming tool ]            |
|                                                             |
| -- Templates --------------------------------------------- |
| Command:     [aider --yes -m {{prompt}}        ]            |
| Continue:    [                                 ]            |
| Headless:    [                                 ]            |
|                                                             |
| > Advanced Settings                                         |
|   Asking Patterns: [                           ]            |
|                                                             |
|                              [Cancel] [Save Changes]        |
+-------------------------------------------------------------+
```

Features:
- AgentForm component (shared with create)
- On success -> redirect to detail page
- Cancel -> return to detail page
- Redirect to list if built-in agent ID

### 4. Header Agents Link

```
+-------------------------------------------------------------+
| Agent Console          [Agents]                             |
+-------------------------------------------------------------+
```

- Position: Right side of header (next to title)
- Always visible for easy discovery
- Active style when on Agents pages

### 5. AgentForm Component

- Shared for create and edit
- react-hook-form + Valibot (CreateAgentRequestSchema / UpdateAgentRequestSchema)
- Advanced Settings toggle for detailed settings
- Read-only mode for built-in agents

## API (Existing - No Changes)

- `GET /api/agents` - List agents
- `GET /api/agents/:id` - Get single agent
- `POST /api/agents` - Create agent
- `PATCH /api/agents/:id` - Update agent
- `DELETE /api/agents/:id` - Delete agent

## Implementation Phases

### Phase 1: Foundation
1. Create `routes/agents/index.tsx` (empty page)
2. Create `routes/agents/$agentId/index.tsx` (empty page)
3. Create `routes/agents/$agentId/edit.tsx` (empty page)
4. Add Agents link to header in `__root.tsx`
5. Remove AgentManagement from dashboard

### Phase 2: List Page
6. Agent list display (using useAgents hook)
7. Create AgentForm component
8. Add agent form (inline toggle)
9. Delete functionality (with ConfirmDialog)

### Phase 3: Detail & Edit Pages
10. Agent detail display (`/agents/:agentId`)
11. Agent edit page (`/agents/:agentId/edit`) - reuse AgentForm
12. Delete from detail page

### Phase 4: Cleanup
13. Delete old AgentManagement.tsx
14. Create and run tests

## Notes

- Built-in Agent (Claude Code) cannot be edited or deleted
- WebSocket events (agent-created, agent-updated, agent-deleted) update cache
- 404 handling: redirect to list for non-existent agentId
