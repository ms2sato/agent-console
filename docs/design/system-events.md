# System Events Design

This document defines the event system used across Agent Console for both inbound (external → internal) and outbound (internal → external) integrations.

## Overview

Agent Console uses an event-driven architecture where system events represent meaningful occurrences that can trigger various actions.

```
┌─────────────────────────────────────────────────────────────┐
│                      System Events                          │
│              (Semantic domain events)                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   External Sources          Internal Sources                │
│   ┌─────────────┐          ┌─────────────┐                 │
│   │   GitHub    │          │   Agent     │                 │
│   │   GitLab    │          │   Worker    │                 │
│   │   Custom    │          │   Session   │                 │
│   └──────┬──────┘          └──────┬──────┘                 │
│          │                        │                         │
│          ▼                        ▼                         │
│   ┌─────────────────────────────────────────┐              │
│   │           SystemEvent                    │              │
│   │   { type, source, payload, ... }        │              │
│   └─────────────────┬───────────────────────┘              │
│                     │                                       │
│                     ▼                                       │
│   ┌─────────────────────────────────────────┐              │
│   │              Handlers                    │              │
│   ├─────────────┬─────────────┬─────────────┤              │
│   │ PTY Write   │ UI Notify   │ Slack       │              │
│   │ Diff Refresh│ Session Mgmt│ Email       │              │
│   └─────────────┴─────────────┴─────────────┘              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Event Format

### TypeScript Definition

```typescript
/**
 * System-wide event representing a meaningful occurrence.
 * Used for both inbound (external → internal) and outbound (internal → external) flows.
 */
interface SystemEvent {
  /**
   * Event type in format `entity:action`.
   * Represents WHAT happened, not WHERE it came from.
   */
  type: SystemEventType;

  /**
   * Event source - WHERE the event originated.
   * Used to distinguish external vs internal events.
   */
  source: EventSource;

  /** Event timestamp (ISO 8601) */
  timestamp: string;

  /** Target session (if applicable) */
  sessionId?: string;

  /** Target worker (if applicable) */
  workerId?: string;

  /**
   * Structured metadata for event routing and matching.
   * Used by resolvers to find target sessions.
   */
  metadata: {
    /** Repository identifier (e.g., 'owner/repo') */
    repositoryName?: string;
    /** Branch name */
    branch?: string;
    /** URL to event details (for display) */
    url?: string;
  };

  /** Full event-specific payload (raw data from source) */
  payload: unknown;

  /** Human-readable summary */
  summary: string;
}

/** Event sources */
type EventSource =
  | 'github'    // GitHub webhooks
  | 'gitlab'    // GitLab webhooks
  | 'internal'; // Agent Console internal events

/**
 * All system event types.
 * This is the union of InboundEventType and OutboundTriggerEventType.
 *
 * @see InboundEventType in integration-inbound.md
 * @see OutboundTriggerEventType in integration-outbound.md
 */
type SystemEventType = InboundEventType | OutboundTriggerEventType;

// For reference, the individual types are:
//
// type InboundEventType =
//   | 'ci:completed'   // CI/CD pipeline succeeded
//   | 'ci:failed'      // CI/CD pipeline failed
//   | 'issue:closed'   // Issue was closed
//   | 'pr:merged';     // Pull request was merged
//
// type OutboundTriggerEventType =
//   | 'agent:waiting'  // Agent is asking a question
//   | 'agent:idle'     // Agent finished processing
//   | 'agent:active'   // Agent is actively processing
//   | 'worker:error'   // Worker encountered an error
//   | 'worker:exited'; // Worker process exited
```

## Event Types

### External Source Events (Inbound)

Events originating from external services (GitHub, GitLab, etc.). These are received via webhooks and converted to system events. See [Inbound Integration](./integration-inbound.md) for `InboundEventType` definition.

| Event Type | Description | Typical Use |
|------------|-------------|-------------|
| `ci:completed` | CI/CD pipeline succeeded | Notify agent, refresh diff |
| `ci:failed` | CI/CD pipeline failed | Notify agent, show UI alert |
| `issue:closed` | Issue was closed | Suggest session archive |
| `pr:merged` | Pull request was merged | Suggest session archive |

### Internal Source Events (Outbound)

Events originating from within Agent Console. These trigger outbound notifications to external services. See [Outbound Integration](./integration-outbound.md) for `OutboundTriggerEventType` definition.

| Event Type | Description | Typical Use |
|------------|-------------|-------------|
| `agent:waiting` | Agent is asking a question | Send Slack notification |
| `agent:idle` | Agent finished processing | Send Slack notification |
| `agent:active` | Agent is actively processing | (Usually not notified) |
| `worker:error` | Worker encountered an error | Send alert notification |
| `worker:exited` | Worker process exited | Send notification |

## Event Flow

### Inbound Flow (External → Internal)

```
GitHub Webhook
      │
      ▼
┌─────────────────┐
│ ServiceParser   │  Authenticate & parse
│ (GitHubParser)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  SystemEvent    │  type: 'ci:completed'
│                 │  source: 'github'
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Event Handlers  │  PTY write, UI notify, etc.
└─────────────────┘
```

See [Inbound Integration](./integration-inbound.md) for details.

### Outbound Flow (Internal → External)

```
Agent Activity Change
      │
      ▼
┌─────────────────┐
│  SystemEvent    │  type: 'agent:waiting'
│                 │  source: 'internal'
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Notification    │  Format & send
│ Services        │
└────────┬────────┘
         │
         ▼
   Slack, Email, etc.
```

See [Outbound Integration](./integration-outbound.md) for details.

## Relationship with WebSocket Messages

WebSocket messages and system events are **different layers**:

| Concept | Role | Examples |
|---------|------|----------|
| **SystemEvent** | Semantic domain event (WHAT happened) | `ci:completed`, `agent:waiting` |
| **WebSocket Message** | Transport protocol (HOW to deliver) | `worker-activity`, `session-created` |

### Existing WebSocket Messages

Current WebSocket messages (defined in `websocket-protocol.md`) are **transport-level**:

```typescript
// These are TRANSPORT messages, not domain events
type AppServerMessage =
  | { type: 'sessions-sync'; ... }
  | { type: 'session-created'; ... }
  | { type: 'worker-activity'; ... }  // Delivers agent:* events
  | ...
```

### How They Relate

System events may be delivered via WebSocket messages:

```typescript
// System event
const event: SystemEvent = {
  type: 'agent:waiting',
  source: 'internal',
  sessionId: '...',
  workerId: '...',
  // ...
};

// Delivered as WebSocket message (existing format)
wsServer.broadcast({
  type: 'worker-activity',
  sessionId: event.sessionId,
  workerId: event.workerId,
  activityState: 'waiting',
});

// Or as new inbound-event message (for external events)
wsServer.broadcast({
  type: 'inbound-event',
  sessionId: event.sessionId,
  event: {
    type: event.type,
    source: event.source,
    summary: event.summary,
    // ...
  },
});
```

## Design Decisions

### Why `entity:action` format?

- **Readable**: `ci:completed` is self-explanatory
- **Groupable**: Easy to match patterns (`ci:*`, `agent:*`)
- **Extensible**: New events follow the same pattern

### Why separate `source` from `type`?

- **Handler independence**: Handlers don't care if `ci:completed` came from GitHub or GitLab
- **Abstraction**: External service differences are hidden from handlers
- **Auditability**: Source is available when needed for logging/debugging

### Why not include `inbound`/`outbound` in event names?

- **Direction is implicit**: Source tells you the direction
  - `source: 'github'` → inbound
  - `source: 'internal'` → potential outbound trigger
- **Simpler naming**: `ci:completed` vs `inbound:ci:completed`
- **Handler flexibility**: Same event type could trigger both inbound handlers and outbound notifications

## Related Documents

- [Inbound Integration](./integration-inbound.md) - Receiving external events
- [Outbound Integration](./integration-outbound.md) - Sending notifications
- [WebSocket Protocol](./websocket-protocol.md) - Transport layer
