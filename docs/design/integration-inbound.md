# Inbound Integration Design

This document describes the design for receiving external events into Agent Console and routing them to appropriate handlers.

> **Prerequisite**: See [System Events](./system-events.md) for event format and type definitions.

## Inbound Event Types

Inbound events are external events received from services like GitHub and GitLab.

```typescript
/** Event types received from external sources */
type InboundEventType =
  | 'ci:completed'   // CI/CD pipeline succeeded
  | 'ci:failed'      // CI/CD pipeline failed
  | 'issue:closed'   // Issue was closed
  | 'pr:merged';     // Pull request was merged
```

> **Note**: `SystemEventType` in [System Events](./system-events.md) is the union of `InboundEventType` and `OutboundTriggerEventType`.

## Overview

Inbound integration provides a **generalized event routing system** that receives external events (webhooks, etc.) and dispatches them to appropriate handlers based on event type and target.

```
External System (e.g., GitHub CI)
        │
        │ Webhook POST
        ▼
Agent Console Server
        │
        │ 1. Authenticate (service-specific)
        │ 2. Parse payload (service-specific)
        │ 3. Match to Session(s)
        │ 4. Route to Handler(s)
        ▼
┌─────────────────────────────────────────────┐
│              Event Handlers                  │
├─────────────┬─────────────┬────────────────┤
│ AgentWorker │ DiffWorker  │ UI Notifier    │
│ (PTY write) │ (refresh)   │ (WebSocket)    │
└─────────────┴─────────────┴────────────────┘
```

## Design Principles

1. **Generalized event routing** - Not tied to specific use cases; handlers determine actions
2. **Multiple targets** - Single event can trigger multiple handlers (PTY, UI, etc.)
3. **Always return 200 OK** - Webhook providers may disable or retry on errors
4. **Async processing via queue** - Authenticate and enqueue immediately, process asynchronously

## Base Architecture

### Components

| Component | Responsibility |
|-----------|----------------|
| Webhook Router | Route requests to service-specific parsers, authenticate, enqueue |
| Event Queue | Store pending events for async processing (uses existing JobQueue) |
| Event Processor | Process queued items: parse, resolve targets, dispatch to handlers |
| Service Parser | Parse service-specific payloads and extract event metadata |
| Event Handler | Execute actions for specific event types (PTY write, UI notify, etc.) |

### Handled Event Types

Inbound integration handles external source events defined in [System Events](./system-events.md):

| Event Type | Possible Handlers |
|------------|-------------------|
| `ci:completed` | AgentWorker (notify), DiffWorker (refresh) |
| `ci:failed` | AgentWorker (notify), UI (alert dialog) |
| `issue:closed` | UI (session close dialog), Session (auto-archive) |
| `pr:merged` | UI (success dialog), Session (auto-archive) |

### Handler Interface

Handlers receive `SystemEvent` (defined in [System Events](./system-events.md)) and process them for specific targets.

```typescript
interface InboundEventHandler {
  /** Handler identifier */
  readonly handlerId: string;

  /** Event types this handler supports */
  readonly supportedEvents: SystemEventType[];

  /**
   * Handle the event for a specific target.
   * Returns true if handled successfully.
   */
  handle(event: SystemEvent, target: EventTarget): Promise<boolean>;
}

interface EventTarget {
  sessionId: string;
  workerId?: string;  // If specified, target specific worker
}
```

### Built-in Handlers

#### 1. AgentWorkerHandler (PTY Write)

Writes formatted message to Agent Worker's PTY stdin.

```typescript
class AgentWorkerHandler implements InboundEventHandler {
  readonly handlerId = 'agent-worker';
  readonly supportedEvents: SystemEventType[] = ['ci:completed', 'ci:failed'];

  async handle(event: SystemEvent, target: EventTarget): Promise<boolean> {
    const worker = this.sessionManager.getWorker(target.sessionId, target.workerId);
    if (!worker || worker.type !== 'agent') return false;

    const message = this.formatMessage(event);
    worker.pty.write(message);
    return true;
  }

  private formatMessage(event: SystemEvent): string {
    // Format: \n[Source] TYPE: Summary\nURL: ...\n
    return `\n[${event.source}] ${event.type.toUpperCase()}: ${event.summary}\n` +
           `URL: ${event.metadata.url ?? 'N/A'}\n`;
  }
}
```

#### 2. DiffWorkerHandler (Refresh)

Triggers DiffWorker to refresh its diff view.

```typescript
class DiffWorkerHandler implements InboundEventHandler {
  readonly handlerId = 'diff-worker';
  readonly supportedEvents: SystemEventType[] = ['ci:completed', 'pr:merged'];

  async handle(event: SystemEvent, target: EventTarget): Promise<boolean> {
    const workers = this.sessionManager.getWorkersByType(target.sessionId, 'git-diff');
    if (workers.length === 0) return false;

    for (const worker of workers) {
      await this.diffService.refresh(worker.id);
    }
    return true;
  }
}
```

#### 3. UINotificationHandler (WebSocket)

Sends notification to connected clients via WebSocket.

```typescript
class UINotificationHandler implements InboundEventHandler {
  readonly handlerId = 'ui-notification';
  readonly supportedEvents: SystemEventType[] = ['ci:failed', 'issue:closed', 'pr:merged'];

  async handle(event: SystemEvent, target: EventTarget): Promise<boolean> {
    // Broadcast to all clients viewing this session
    this.appWebSocket.broadcast({
      type: 'inbound-event',
      sessionId: target.sessionId,
      event: {
        type: event.type,
        source: event.source,
        summary: event.summary,
      },
    });
    return true;
  }
}
```

### Flow

```typescript
// Pseudocode for inbound integration flow

// Step 1: Receive webhook (synchronous, fast)
app.post('/webhooks/:service', async (c) => {
  const service = c.req.param('service');
  const parser = getServiceParser(service);

  // Authenticate (service-specific)
  const payload = await c.req.text();
  if (!await parser.authenticate(payload, c.req.raw.headers)) {
    logger.warn({ service }, 'Webhook authentication failed');
    return c.json({ ok: true }); // Always 200 OK
  }

  // Enqueue for async processing
  const jobId = generateId();
  jobQueue.enqueue('inbound-event:process', {
    jobId,
    service,
    rawPayload: payload,
    headers: Object.fromEntries(c.req.raw.headers),
    receivedAt: new Date().toISOString(),
  } satisfies InboundEventJobPayload);

  return c.json({ ok: true });
});

// Step 2: Process queue (asynchronous)
jobQueue.registerHandler('inbound-event:process', async (job: InboundEventJobPayload) => {
  const parser = getServiceParser(job.service);

  // Parse payload into event
  const event = await parser.parse(job.rawPayload, job.headers);
  if (!event) return; // Unsupported event type

  // Resolve targets (sessions matching repository/branch)
  const targets = await resolveTargets(event);
  if (targets.length === 0) return; // No matching sessions

  // Dispatch to all applicable handlers
  const handlers = getHandlersForEvent(event.type);

  for (const target of targets) {
    for (const handler of handlers) {
      const handled = await handler.handle(event, target);

      // Record notification history
      if (handled) {
        await inboundEventNotificationRepository.create({
          id: generateId(),
          jobId: job.jobId,
          sessionId: target.sessionId,
          workerId: target.workerId ?? 'all',
          handlerId: handler.handlerId,
          eventType: event.type,
          eventSummary: event.summary,
          notifiedAt: new Date().toISOString(),
        });
      }
    }
  }
});
```

## Database Schema

### Kysely Schema Definition

Add to `packages/server/src/database/schema.ts`:

```typescript
/**
 * Inbound event notifications table schema.
 * Records history of external events delivered to sessions/workers.
 */
export interface InboundEventNotificationsTable {
  /** Primary key - UUID */
  id: string;
  /** Reference to jobs.id for the original webhook job */
  job_id: string;
  /** Session that received this notification */
  session_id: string;
  /** Worker that received this notification ('all' if session-wide) */
  worker_id: string;
  /** Handler that processed this event */
  handler_id: string;
  /** Event type (e.g., 'ci:completed') */
  event_type: string;
  /** Human-readable event summary */
  event_summary: string;
  /** Timestamp when notification was delivered */
  notified_at: string;
}

// Add to Database interface:
export interface Database {
  // ... existing tables
  inbound_event_notifications: InboundEventNotificationsTable;
}

// Helper types
export type InboundEventNotification = Selectable<InboundEventNotificationsTable>;
export type NewInboundEventNotification = Insertable<InboundEventNotificationsTable>;
```

### Migration

```typescript
// migrations/007_create_inbound_event_notifications.ts
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('inbound_event_notifications')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('job_id', 'text', (col) => col.notNull())
    .addColumn('session_id', 'text', (col) => col.notNull())
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('handler_id', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('event_summary', 'text', (col) => col.notNull())
    .addColumn('notified_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_inbound_event_notifications_job')
    .on('inbound_event_notifications')
    .column('job_id')
    .execute();

  await db.schema
    .createIndex('idx_inbound_event_notifications_session_worker')
    .on('inbound_event_notifications')
    .columns(['session_id', 'worker_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('inbound_event_notifications').execute();
}
```

### Job Payload (stored in existing `jobs.payload`)

```typescript
interface InboundEventJobPayload {
  jobId: string;                // Same as jobs.id (for cross-reference)
  service: string;              // 'github', 'gitlab', etc.
  rawPayload: string;           // Raw JSON payload
  headers: Record<string, string>;
  receivedAt: string;           // ISO timestamp
}
```

### Querying Event History

```typescript
// Get events received by a specific Worker
const events = await db
  .selectFrom('inbound_event_notifications as ien')
  .innerJoin('jobs as j', 'ien.job_id', 'j.id')
  .where('ien.session_id', '=', sessionId)
  .where('ien.worker_id', '=', workerId)
  .select([
    'ien.notified_at',
    'ien.event_type',
    'ien.event_summary',
    'ien.handler_id',
    'j.payload',
    'j.status',
  ])
  .orderBy('ien.notified_at', 'desc')
  .limit(50)
  .execute();
```

## Session Resolution

### Repository Matching

Sessions are matched to webhooks by comparing repository identifiers.

**Challenge**: `RepositoriesTable` does not store `remote_url`. Remote URL is fetched at runtime via `git remote get-url origin`.

**Approaches**:

1. **Runtime resolution** (current approach):
   ```typescript
   async function resolveTargets(event: SystemEvent): Promise<EventTarget[]> {
     const sessions = await sessionRepository.findAll();
     const targets: EventTarget[] = [];

     for (const session of sessions) {
       if (!session.repositoryId) continue; // Skip quick sessions

       const repository = await repositoryRepository.findById(session.repositoryId);
       if (!repository) continue;

       // Get remote URL at runtime
       const remoteUrl = await getRemoteUrl(repository.path);
       if (!remoteUrl) continue;

       // Compare org/repo using metadata
       const repoOrgRepo = parseOrgRepo(remoteUrl);
       const eventRepoName = event.metadata.repositoryName;
       if (!eventRepoName) continue;

       if (repoOrgRepo?.toLowerCase() === eventRepoName.toLowerCase()) {
         // Optionally match branch via worktreeId
         if (!event.metadata.branch || session.worktreeId === event.metadata.branch) {
           targets.push({ sessionId: session.id });
         }
       }
     }

     return targets;
   }
   ```

2. **Cache remote URL** (optimization):
   - Add `remote_url` column to `RepositoriesTable`
   - Populate on repository registration
   - Update periodically or on access

**Recommendation**: Start with runtime resolution. Add caching if performance becomes an issue (unlikely with typical session counts).

### Service Parser Interface

Service parsers authenticate webhooks and convert raw payloads to `SystemEvent`.

```typescript
interface ServiceParser {
  /** Service identifier (e.g., 'github', 'gitlab') */
  readonly serviceId: string;

  /** Authenticate the incoming webhook request */
  authenticate(payload: string, headers: Headers): Promise<boolean>;

  /**
   * Parse raw payload into SystemEvent.
   * Returns null if the event type is not supported.
   */
  parse(payload: string, headers: Record<string, string>): Promise<SystemEvent | null>;
}
```

## GitHub Implementation

### Endpoint

```
POST /webhooks/github
```

### Authentication

```typescript
class GitHubServiceParser implements ServiceParser {
  async authenticate(payload: string, headers: Headers): Promise<boolean> {
    const signature = headers.get('X-Hub-Signature-256');
    if (!signature) return false;

    const expected = 'sha256=' +
      crypto.createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  }
}
```

### Event Parsing

```typescript
async parse(payload: string, headers: Record<string, string>): Promise<SystemEvent | null> {
  const body = JSON.parse(payload);
  const githubEvent = headers['x-github-event'];

  switch (githubEvent) {
    case 'workflow_run':
      if (body.action !== 'completed') return null;
      return this.parseWorkflowRun(body);

    case 'issues':
      if (body.action !== 'closed') return null;
      return this.parseIssueClosed(body);

    case 'pull_request':
      return this.parsePullRequest(body);

    default:
      return null; // Unsupported event
  }
}

private parseWorkflowRun(body: unknown): SystemEvent {
  const conclusion = body.workflow_run.conclusion;
  return {
    type: conclusion === 'success' ? 'ci:completed' : 'ci:failed',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: body.repository.full_name,
      branch: body.workflow_run.head_branch,
      url: body.workflow_run.html_url,
    },
    payload: body,
    summary: `${body.workflow_run.name} ${conclusion}`,
  };
}

private parseIssueClosed(body: unknown): SystemEvent {
  return {
    type: 'issue:closed',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: body.repository.full_name,
      url: body.issue.html_url,
    },
    payload: body,
    summary: `Issue #${body.issue.number} closed: ${body.issue.title}`,
  };
}

private parsePullRequest(body: unknown): SystemEvent | null {
  const action = body.action;

  if (action === 'closed' && body.pull_request.merged) {
    return {
      type: 'pr:merged',
      source: 'github',
      timestamp: new Date().toISOString(),
      metadata: {
        repositoryName: body.repository.full_name,
        branch: body.pull_request.head.ref,
        url: body.pull_request.html_url,
      },
      payload: body,
      summary: `PR #${body.pull_request.number} merged: ${body.pull_request.title}`,
    };
  }

  return null; // Unsupported pull_request action
}
```

## Configuration

### Handler Registration

```typescript
interface InboundIntegrationConfig {
  /** Enabled handlers and their event subscriptions */
  handlers: {
    'agent-worker': {
      enabled: boolean;
      events: string[];  // e.g., ['ci:completed', 'ci:failed']
    };
    'diff-worker': {
      enabled: boolean;
      events: string[];
    };
    'ui-notification': {
      enabled: boolean;
      events: string[];
    };
  };

  /** Service-specific settings */
  services: {
    github?: {
      webhookSecret: string;
      enabled: boolean;
    };
  };
}
```

### Environment Variables

```bash
# GitHub webhook secret
GITHUB_WEBHOOK_SECRET=your-secret-here
```

## Future Extensions

### Adding New Handlers

1. Implement `InboundEventHandler` interface
2. Register in handler registry
3. Add configuration options
4. Document supported events

### Adding New Services

1. Implement `ServiceParser` interface
2. Register in webhook router
3. Add authentication method
4. Document webhook setup

### Session Actions (Future)

Handlers that perform session-level actions:

```typescript
class SessionActionHandler implements InboundEventHandler {
  readonly handlerId = 'session-action';
  readonly supportedEvents: SystemEventType[] = ['issue:closed', 'pr:merged'];

  async handle(event: SystemEvent, target: EventTarget): Promise<boolean> {
    // Example: Show dialog suggesting to close session
    if (event.type === 'issue:closed' || event.type === 'pr:merged') {
      this.appWebSocket.broadcast({
        type: 'session-action-suggestion',
        sessionId: target.sessionId,
        action: 'archive',
        reason: event.summary,
      });
    }
    return true;
  }
}
```

## API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhooks/github` | Receive GitHub webhook events |
| POST | `/webhooks/:service` | Generic service webhook (future) |

### Response

Always returns 200 OK:
```json
{
  "ok": true
}
```

**Important**: No error responses are returned to prevent webhook providers from retrying or disabling endpoints.

## Related Documents

- [System Events](./system-events.md) - Event format and type definitions
- [Outbound Integration](./integration-outbound.md) - Sending notifications to external systems
- [Local Job Queue](./local-job-queue-design.md) - Async job processing infrastructure
