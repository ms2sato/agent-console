# Glossary

This document defines canonical terminology used throughout the Agent Console project to resolve terminology drift across documentation and codebase.

## Core Architecture

### Agent
A general term for AI-powered tools like Claude Code. See also: [AgentDefinition](#agentdefinition), [AgentWorker](#agentworker).

### AgentDefinition
The stored configuration for an AI agent, including command templates and activity patterns. Referenced by `agentId` in [AgentWorker](#agentworker).
- **Aliases:** Agent configuration, Agent preset
- **See:** [Agent concepts in session-worker-design.md](design/session-worker-design.md#agent-types)

### Repository
A registered Git repository available for session creation. Code reference: `repositoryId` (UUID).
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

### Session
A work session tied to a directory location, containing one or more workers.
- **Aliases:** Work session
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

### Worker
A work unit within a session (agent, terminal, diff viewer, etc.).
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

### Worktree
A Git worktree representing a physical working directory.
- **See:** [Core concepts in session-worker-design.md](design/session-worker-design.md#key-concepts)

## Session Types

### PersonalSession
A session created and owned by an authenticated user, running with that user's OS identity.
- **Contrast:** [SharedSession](#sharedsession)
- **See:** [Multi-user terminology in multi-user-shared-setup.md](design/multi-user-shared-setup.md#terminology)

### QuickSession
A session tied only to a directory path, without repository or worktree management.
- **Contrast:** [WorktreeSession](#worktreesession)
- **See:** [Session types in session-worker-design.md](design/session-worker-design.md#session-types)

### SharedSession
A session running under a shared account OS identity, accessible to all authenticated users.
- **Contrast:** [PersonalSession](#personalsession)
- **See:** [Terminology in shared-orchestrator-session.md](design/shared-orchestrator-session.md#terminology)

### WorktreeSession
A session tied to a repository and worktree, with branch management features.
- **Contrast:** [QuickSession](#quicksession)
- **See:** [Session types in session-worker-design.md](design/session-worker-design.md#session-types)

## Worker Types

### AgentWorker
A worker running an AI agent with activity detection and PTY capabilities.
- **See:** [Worker types in session-worker-design.md](design/session-worker-design.md#worker-types-current--future)

### TerminalWorker
A worker running a plain terminal shell.
- **See:** [Worker types in session-worker-design.md](design/session-worker-design.md#worker-types-current--future)

## States

### AgentActivityState
The detected activity state of an agent: 'active', 'idle', 'asking', or 'unknown'.
- **See:** [Agent activity state in session-worker-design.md](design/session-worker-design.md#type-definitions)

### SessionActivationState
Whether a session has active PTY processes: 'running' or 'hibernated'.
- **Aliases:** Activation state
- **See:** [Session activation in session.ts](../packages/shared/src/types/session.ts)

### SessionStatus
The logical status of a session: 'active' or 'inactive'.
- **See:** [Session status in session-worker-design.md](design/session-worker-design.md#type-definitions)

## Multi-User Identity

### assignee
PR #682 で導入された delegate target user identifier (`delegate_to_worktree.assignee`).
- **Aliases:** target user, caller (PR #682 草案で一時使用)
- **See:** [Orchestrator-facing interface in shared-orchestrator-session.md](design/shared-orchestrator-session.md#orchestrator-facing-interface)

### authenticated user
Agent-console UI に認証してアクセスする end-user.
- **Aliases:** end user, User (capitalised in setup guide)
- **See:** [Multi-user terminology in multi-user-shared-setup.md](design/multi-user-shared-setup.md#terminology)
- **Contrast:** [created_by](#created_by) (PTY OS identity), [initiated_by](#initiated_by) (audit trail)

### created_by
Database field identifying the session owner (whose OS identity runs the PTY process).
- **Aliases:** session owner, session creator
- **Contrast:** [initiated_by](#initiated_by)
- **See:** [Session ownership in multi-user-shared-setup.md](design/multi-user-shared-setup.md#user-identity)

### initiated_by
Database field identifying the authenticated user who actually created the session (audit trail).
- **Contrast:** [created_by](#created_by)  
- **See:** [Schema notes in shared-orchestrator-session.md](design/shared-orchestrator-session.md#schema-notes)

### Service User
The dedicated OS account (typically `agentconsole`) that runs the server process.
- **Aliases:** Server service user, agentconsole service user, server process user
- **See:** [Terminology in multi-user-shared-setup.md](design/multi-user-shared-setup.md#terminology)

### Shared Account
A dedicated OS account distinct from service user and individual users, used for shared sessions.
- **Aliases:** Shared session account, shared service account (historical, briefly used in PR #682 draft)
- **See:** [Terminology in shared-orchestrator-session.md](design/shared-orchestrator-session.md#terminology)

## Events & Communication

### SystemEvent
The top-level event format representing meaningful occurrences in the system.
- **Aliases:** System-wide event
- **See:** [Event format in system-events.md](design/system-events.md#event-format)

### WebSocket Connection
Real-time bidirectional communication channel between client and server.
- **Types:** App Connection (`/ws/app`), Worker Connection (`/ws/session/:id/worker/:id`)
- **See:** [WebSocket protocol in websocket-protocol.md](design/websocket-protocol.md)

## Maintenance

This glossary is canonical. When the following changes are introduced, the glossary must be updated in the same PR:

- New design doc (`docs/design/`) introducing a new domain concept
- New type, DB schema field, or API endpoint name representing a domain concept
- Existing design doc's Terminology section is added, renamed, or revised
- New rule / skill / narrative referring to a project-wide concept

If a term in the codebase or documentation does not appear here, either it is a drift to fix or a missing entry to add — both belong in the same PR that surfaced the gap.

**Responsibility**: PR author owns the glossary update for their PR. Orchestrator confirms during acceptance check. Automated detection is tracked separately (see Issue [#671](https://github.com/ms2sato/agent-console/issues/671) and Issue [#689](https://github.com/ms2sato/agent-console/issues/689) for `glossary-maintenance` rule integration).