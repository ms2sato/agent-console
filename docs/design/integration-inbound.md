# Inbound Integration Design

This document describes the design for receiving external events into Agent Console and routing them to appropriate handlers.

> **Prerequisite**: See [System Events](./system-events.md) for event format and type definitions.

## Inbound Event Types

Inbound events are external events received from services like GitHub and GitLab.

```typescript
/** Event types received from external sources */
type InboundEventType =
  | 'ci:completed'          // CI/CD pipeline succeeded
  | 'ci:failed'             // CI/CD pipeline failed
  | 'issue:closed'          // Issue was closed
  | 'pr:merged'             // Pull request was merged
  | 'pr:review_comment'     // PR review comment posted
  | 'pr:changes_requested'  // PR changes requested
  | 'pr:comment';           // PR general comment posted
```

> **Note**: `SystemEventType` in [System Events](./system-events.md) is the union of `InboundEventType` and `OutboundTriggerEventType`.

```typescript
/** Inbound system event — a SystemEvent constrained to inbound event types */
type InboundSystemEvent = SystemEvent & { type: InboundEventType };
```

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
│ (notify)    │ (refresh)   │ (WebSocket)    │
└─────────────┴─────────────┴────────────────┘
```

## Design Principles

1. **Generalized event routing** - Not tied to specific use cases; handlers determine actions
2. **Multiple targets** - Single event can trigger multiple handlers (PTY, UI, etc.)
3. **Always return 200 OK** (except the one signed generic route, `/webhooks/in/:endpointId`) - See [Error Handling Policy](#error-handling-policy) for rationale
4. **Async processing via queue** - Authenticate and enqueue immediately, process asynchronously

### Error Handling Policy

**Webhook endpoints always return 200 OK, regardless of internal errors** (with one deliberate carve-out for `POST /webhooks/in/:endpointId`, described after the table below).

This is a fundamental webhook receiver principle. Unlike API endpoints (which should return proper error codes), webhook endpoints must not burden the sending service with the receiver's problems.

**Rationale:**

- Webhook senders (e.g., GitHub) retry on non-2xx responses
- Configuration errors (wrong secret, missing parser) are permanent — retries will never fix them, only generating wasted load
- Persistent error responses may cause the sender to disable the webhook entirely
- The receiver's internal failures are the receiver's responsibility to detect and resolve

**All error cases return 200 OK:**

| Error Case | Internal Action | Why Not an Error Response |
|------------|----------------|--------------------------|
| Webhook secret not configured | Log warning | Permanent config error — retries are futile |
| Signature verification failed | Log warning | Permanent secret mismatch — retries are futile |
| Service parser not registered | Log warning | Permanent code issue — retries are futile |
| Job enqueue failed | Log error with full raw data (see below) | Likely persistent system failure (DB down) — retries won't help |

**Scope of the always-200 policy.** It covers POST on known webhook paths only. Any other method on a known path answers `405` with `Allow: POST`, and any unknown path under `/webhooks/` answers `404`; both responses are JSON. This is router-wide (the `postOnly` helper plus a trailing catch-all in `routes/webhooks.ts`), so any future webhook route inherits it. Without it those requests would fall through to the SPA fallback and answer `200` with `index.html`. GitHub only POSTs, so the policy for senders is not weakened.

**Carve-out: `POST /webhooks/in/:endpointId` is the one route that does NOT always answer 200.** A generic signed endpoint has a sender that retries on 5xx and on a few 4xx codes and treats every other 4xx as permanent, and the receive path is cheap enough (two small SQLite writes, no network) to fit the sender's 5 s budget, so it answers with real status codes: 404 unknown endpoint, 401 bad signature or stale timestamp, 400 invalid delivery id or body, 413 oversized body, 200 accepted or duplicate, 503 when the transaction fails, 500 for anything unhandled. `/webhooks/github` is unchanged and keeps the always-200 policy. See [Generic Signed Webhook Endpoints](#generic-signed-webhook-endpoints).

**Enqueue failure recovery strategy:**

When job enqueue fails, the event has not been persisted anywhere. The endpoint must:

1. Return 200 OK (do not burden the sender)
2. Log the error at ERROR level with the **full raw request data** for manual recovery:
   - `rawPayload` (the webhook JSON body)
   - `headers` (including `x-github-event`, etc.)
   - `service` identifier
   - Error details
3. Accept the data loss for automated processing

The raw data in logs enables an operator to manually replay the event if needed. Automatic replay (e.g., saving to a file and re-enqueuing on next startup) is intentionally avoided because session/worker state may have changed since the original event, making stale events likely to cause inconsistencies.

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
| `pr:review_comment` | AgentWorker (notify), UI (alert) |
| `pr:changes_requested` | AgentWorker (notify), UI (alert) |
| `pr:comment` | AgentWorker (notify), UI (alert) |
| `external:message` | AgentWorker (notify the repository's designated Orchestrators; see [Generic Signed Webhook Endpoints](#generic-signed-webhook-endpoints)) |

### Handler Interface

Handlers receive `InboundSystemEvent` (defined in [System Events](./system-events.md)) and process them for specific targets.

```typescript
interface InboundEventHandler {
  /** Handler identifier */
  readonly handlerId: string;

  /** Event types this handler supports (inbound events only) */
  readonly supportedEvents: InboundEventType[];

  /**
   * Handle the event for a specific target.
   * `opts.jobId` is the inbound job that produced the event.
   * Returns `'handled'` if the handler performed an action, `'not-applicable'`
   * if it had nothing to do, `'delivery-failed'` if it should have delivered
   * but the delivery itself failed.
   */
  handle(event: InboundSystemEvent, target: EventTarget, opts: InboundHandleOptions): Promise<HandlerOutcome>;
}

type HandlerOutcome = 'handled' | 'not-applicable' | 'delivery-failed';

interface InboundHandleOptions {
  jobId: string;
}

interface EventTarget {
  sessionId: string;
  workerId?: string;  // If specified, target specific worker
  provenance: 'match' | 'parent' | 'fallback';  // How the target was resolved
}
```

### Built-in Handlers

#### 1. AgentWorkerHandler (agent-shaped worker notification)

Delivers a structured `[inbound:<type>]` notification to the session's agent-shaped worker — a PTY `agent` worker or an `embedded-agent` worker — through `SessionManager.deliverWorkerNotification`, the kind-aware seam shared with timers, conditional wakeups, `send_session_message` and `run_process` output. The handler never branches on worker kind itself (Issue [#1739](https://github.com/ms2sato/agent-console/issues/1739)); see [Delivery shape by worker kind](#designated-orchestrator-sessions) for what each kind receives.

```typescript
class AgentWorkerHandler implements InboundEventHandler {
  readonly handlerId = 'agent-worker';
  readonly supportedEvents: InboundEventType[] = [
    'ci:completed', 'ci:failed', 'issue:labeled', 'pr:merged',
    'pr:review_comment', 'pr:changes_requested', 'pr:comment',
  ];

  async handle(event: InboundSystemEvent, target: EventTarget, opts: InboundHandleOptions): Promise<HandlerOutcome> {
    // A paused session is not in memory; resolve it from persistence so the
    // delivery seam can defer to it (the resolver returns null for a live,
    // deleted or orphaned session).
    // The resolver reads persistence and can reject; the handler's contract
    // is "an outcome, never a rejection", so a failed lookup is a failed
    // delivery attempt.
    let session: Session | undefined;
    try {
      session =
        this.sessionManager.getSession(target.sessionId) ??
        (await this.sessionManager.resolvePausedMessageTarget(target.sessionId))?.session;
    } catch (err) {
      logger.error({ err, sessionId: target.sessionId, eventType: event.type }, 'Could not resolve the target session from persistence for inbound event');
      return 'delivery-failed';
    }
    if (!session) return 'not-applicable';
    if (!target.workerId && !canDeliverToAgentWorker(session)) return 'not-applicable';

    // First agent-shaped worker in session.workers order (deterministic).
    const workerId = target.workerId ?? session.workers.find(canReceiveSessionMessages)?.id;
    if (!workerId) return 'not-applicable';

    // Format: structured tag + key/value fields for reliable parsing. The PTY
    // branch renders `\n[inbound:<type>] timestamp=... type=... source=... repo=...
    // branch=... url=... summary="..." intent=...`; the embedded branch delivers
    // the same text as a system-notification turn (notification.kind = 'inbound-event').

    // The PTY branch of the seam never throws, but the embedded-agent branch
    // can reject (e.g. an activation failure). The handler's contract is
    // "an outcome, never a rejection", so both failure shapes end up as
    // 'delivery-failed'.
    let result;
    try {
      result = await this.sessionManager.deliverWorkerNotification(target.sessionId, workerId, {
        kind: 'inbound-event',
        tag: `inbound:${event.type}`,
        fields: {
          type: event.type,
          source: event.source,
          repo: event.metadata.repositoryName ?? 'unknown',
          branch: event.metadata.branch ?? 'unknown',
          url: event.metadata.url ?? 'N/A',
          summary: event.summary,
        },
        intent: this.resolveIntent(event.type),
      }, { sourceId: opts.jobId });
    } catch (err) {
      logger.warn({ err, sessionId: target.sessionId, workerId, eventType: event.type }, 'notification delivery failed for inbound event');
      return 'delivery-failed';
    }
    if (!result.ok) return 'delivery-failed';

    // `deferred: true` means the session is paused and the notification is
    // stored for its resume digest; the obligation is met, so this is
    // 'handled' exactly as for a live delivery.
    return 'handled';
  }

  /**
   * Resolve the intent for a given event type.
   * Exhaustive over InboundEventType (not just supportedEvents) so the
   * compiler forces a decision when new event types are added to the union.
   */
  private resolveIntent(type: InboundEventType): 'inform' | 'triage' {
    switch (type) {
      case 'ci:completed':
      case 'pr:merged':
        return 'inform';
      case 'ci:failed':
      case 'issue:closed':
      case 'issue:labeled':
      case 'pr:review_comment':
      case 'pr:changes_requested':
      case 'pr:comment':
        return 'triage';
    }
  }
}
```

#### 2. DiffWorkerHandler (Refresh)

Triggers DiffWorker to refresh its diff view. It acts only on a direct `match` target whose session is live and has a `git-diff` worker. A paused target returns `'not-applicable'`: `getSession()` has no in-memory session for it, so there is nothing to refresh.

```typescript
class DiffWorkerHandler implements InboundEventHandler {
  readonly handlerId = 'diff-worker';
  readonly supportedEvents: InboundEventType[] = ['ci:completed', 'pr:merged'];

  async handle(_event: InboundSystemEvent, target: EventTarget, _opts: InboundHandleOptions): Promise<HandlerOutcome> {
    if (target.provenance !== 'match') return 'not-applicable';

    // A paused session is not in memory, so this is undefined for it.
    const session = this.sessionManager.getSession(target.sessionId);
    if (!session) return 'not-applicable';

    const hasDiffWorker = session.workers.some((worker) => worker.type === 'git-diff');
    if (!hasDiffWorker) return 'not-applicable';

    triggerRefresh(session.locationPath);
    return 'handled';
  }
}
```

#### 3. UINotificationHandler (WebSocket)

Sends notification to connected clients via WebSocket.

```typescript
class UINotificationHandler implements InboundEventHandler {
  readonly handlerId = 'ui-notification';
  readonly supportedEvents: InboundEventType[] = [
    'ci:failed', 'issue:closed', 'issue:labeled', 'pr:merged',
    'pr:review_comment', 'pr:changes_requested', 'pr:comment',
  ];

  async handle(event: InboundSystemEvent, target: EventTarget, _opts: InboundHandleOptions): Promise<HandlerOutcome> {
    // Broadcast to all clients viewing this session
    this.broadcastToApp({
      type: 'inbound-event',
      sessionId: target.sessionId,
      event: {
        type: event.type,
        source: event.source,
        summary: event.summary,
        metadata: event.metadata,
      },
    });
    return 'handled';
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
  try {
    jobQueue.enqueue('inbound-event:process', {
      jobId,
      service,
      rawPayload: payload,
      headers: Object.fromEntries(c.req.raw.headers),  // Stored as Record for serialization
      receivedAt: new Date().toISOString(),
    } satisfies InboundEventJobPayload);
  } catch (error) {
    // Enqueue failed — event is NOT persisted. Log full raw data for manual recovery.
    // Still return 200 OK — do not burden the sender with our internal failures.
    logger.error({
      err: error,
      service,
      headers: Object.fromEntries(c.req.raw.headers),
      rawPayload: payload,
    }, 'Failed to enqueue webhook job - event data preserved for manual recovery');
  }

  return c.json({ ok: true }); // Always 200 OK — see Error Handling Policy
});

// Step 2: Process queue (asynchronous)
jobQueue.registerHandler('inbound-event:process', async (job: InboundEventJobPayload) => {
  const parser = getServiceParser(job.service);

  // Convert stored Record back to Headers for parsing
  const headers = new Headers(job.headers);

  // Parse payload into event
  const event = await parser.parse(job.rawPayload, headers);
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

> **Prerequisite**: This design uses the `jobs` table from [Local Job Queue](./local-job-queue-design.md).

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
  /**
   * Notification status: 'pending' means a processing attempt is
   * currently in flight, OR a prior attempt ran the handler and its
   * terminal bookkeeping write (markNotificationDelivered /
   * markNotificationFailed) failed -- the outcome is unconfirmed; see
   * the accompanying error/warn log line naming this row. Never re-run
   * the handler for a 'pending' row. 'delivered' means the handler
   * completed without a delivery failure (includes "nothing to do
   * here"). 'failed' means the handler determined delivery should
   * happen and it did not -- both are terminal statuses, never retried.
   * A 'pending' row is NEVER administratively closed out as either
   * terminal status on a later job retry -- doing so would risk
   * recording a known delivery failure as a successful delivery (or
   * vice versa).
   */
  status: string;
  /** Timestamp when notification was created (pending status) */
  created_at: string;
  /** Timestamp when notification was delivered (null unless delivered) */
  notified_at: string | null;
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
// Migration v11 in packages/server/src/database/connection.ts
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
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('notified_at', 'text')
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
   async function resolveTargets(event: InboundSystemEvent): Promise<EventTarget[]> {
     // collectRoutableSessions: live sessions first, then paused ones
     // (de-duplicated by id; orphaned sessions are excluded). Read once per call.
     const live = sessionManager.getSessions();
     let paused: Session[] = [];
     try {
       paused = await sessionManager.getAllPausedSessions();
     } catch (err) {
       // Logged at error level; routing continues with live sessions only.
       logger.error({ err }, 'Failed to load paused sessions for inbound routing');
     }
     const liveIds = new Set(live.map((s) => s.id));
     const sessions = [
       ...live,
       ...paused.filter((s) => !liveIds.has(s.id) && s.recoveryState !== 'orphaned'),
     ];
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
           targets.push({ sessionId: session.id, provenance: 'match' });
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

### Designated Orchestrator sessions

A Repository row holds a SET of designated Orchestrator sessions (`repository_orchestrator_sessions`, Issue [#1716](https://github.com/ms2sato/agent-console/issues/1716); the model itself — add/remove of one's own session, multi-delivery with self-selection — is specified in [shared-orchestrator-session.md § Designation in multi-user](./shared-orchestrator-session.md#designation-in-multi-user)). On the wire it is `Repository.orchestratorSessionIds: string[]`. This section is what `resolveTargets` (`packages/server/src/services/inbound/resolve-targets.ts`) does with it.

**Two paths read the set.**

1. **`issue:labeled` routes ONLY to designated sessions.** The event never fans out to a repository's active sessions and never notifies a parent session. For every locally-registered repository whose remote matches the webhook's `repository.full_name` (there can be several — `registerRepository` rejects a duplicate path, not a duplicate remote), the event's label(s) are matched against that row's `issueTriggerLabels` (comma-separated, case-insensitive, trimmed; an unset configuration never matches). A matching row contributes every one of its designated sessions that passes the per-session exclusions below. A row with zero designations contributes nothing (logged: matched repository, no designated orchestrator sessions).
2. **The #1661 fallback, for every other event type.** When the per-session loop resolves to nobody, or to a matching session with no parent, or to a matching session whose parent is not live, the event falls back to the designated sessions of every matched row — the same iteration and the same per-session exclusions as path 1 — each appended with `fallback: true` unless that session is already a genuine target. `hasLiveParentTarget` is a single boolean across the whole loop (Shape C's contract is "somebody responsible is told", not "every dead parent gets its own fallback").

**Per-session exclusions, evaluated for each designated session independently, each with its own log reason.** One ineligible session never short-circuits the others on the same row, and one ineligible row never short-circuits the other rows.

| The designated session… | Skipped, logged as |
|---|---|
| is neither live nor paused: deleted, or orphaned (a paused session's DB row survives and `getPausedSessions()` returns it; an orphaned row is excluded) | not a live session |
| is paused (persisted, no owning server, not orphaned) | NOT skipped: a deferred target. The event is stored for the session's resume digest (`session-pause-resume.md`) and the ledger row becomes `delivered`. A paused session is recognised by membership in `getPausedSessions()`, never by `activationState`, which reads `hibernated` for a paused session AND for a live session whose workers have all exited |
| is live with `activationState !== 'running'` (hibernated: all its PTY workers have exited) | not running |
| fails `canDeliverToAgentWorker` (no agent-shaped worker: neither a PTY `agent` nor an `embedded-agent` — e.g. a worktree session whose only worker is `git-diff`, which computes `running` vacuously) | no agent worker to deliver to |

**Paused sessions are targets on every path (Issue [#2204](https://github.com/ms2sato/agent-console/issues/2204), PR-2).** `TargetResolverDependencies.getPausedSessions()` (`SessionManager.getAllPausedSessions()`) supplies the paused sessions; the per-session loop iterates live sessions first, then paused ones (de-duplicated by id), so a paused session whose worktree matches the event is a `match` target, a paused parent with an agent-shaped worker counts as a live parent for `hasLiveParentTarget`, and a paused designated session is eligible on both the `issue:labeled` path and the #1661 fallback. Each routing decision to a paused session logs one info line naming `paused`. `InboundEventHandler.handle(event, target, { jobId })` receives the inbound job id; `AgentWorkerHandler` resolves a paused session through `SessionManager.resolvePausedMessageTarget`, passes the job id as `sourceId` to `deliverWorkerNotification`, and maps `{ ok: true, deferred: true }` to `'handled'`, so the ledger row is `delivered` exactly as for a live delivery. `DiffWorkerHandler` is a no-op for a paused target (a paused session is not in `getSession()`). A failure to load paused sessions is logged at error level and routing continues with live sessions only: `SessionManager.getAllPausedSessions()` skips (and warns about) a single malformed persisted row so the others are still returned, and `resolveTargets` catches a whole-provider failure (for example a database error) at its boundary.

Targets are collected into a `Set` keyed by session id, so a session designated on two same-remote rows is delivered to once. There is no precedence among designated sessions and no ordering guarantee beyond the deduplication; each recipient decides for itself whether the event is its responsibility, and recipients coordinate through `send_session_message` when they act.

**Delivery shape by worker kind.** `AgentWorkerHandler` (`services/inbound/handlers.ts`) resolves the target worker as the first worker in `session.workers` order that satisfies `canReceiveSessionMessages` (PTY `agent` or `embedded-agent`) and hands one structured params object — `kind: 'inbound-event'`, tag `inbound:<type>`, fields `type, source, repo, branch, url, summary`, `intent` — to `SessionManager.deliverWorkerNotification`, the same kind-aware seam timers, conditional wakeups, `send_session_message` and `run_process` output already use (Issue [#1739](https://github.com/ms2sato/agent-console/issues/1739)). The seam routes by kind:

- **PTY `agent`**: the `[inbound:<type>] timestamp=… type=… source=… repo=… branch=… url=… summary=… intent=…` PTY notification, rendered through the identical `writePtyNotification` — byte-for-byte what the handler wrote before the seam (pinned in `handlers.test.ts` against a fixture captured from the pre-seam code).
- **`embedded-agent`**: the SAME text (`buildPtyNotificationText` over the same params) delivered as a system-notification user turn persisted with `notification.kind = 'inbound-event'` (the client renders it as "Inbound Event"). If a turn is already active it is parked on the R3 mid-turn queue (one delivery per `idle`, cap 32, oldest dropped with a warning; see [embedded-agent-worker.md](./embedded-agent-worker.md)). A dormant or evicted worker is activated first: `sendSystemNotification` → `deliverUserTurn`, whose first statement is `ensureDeliverable`, which awaits any in-flight eviction and calls `activate` when `worker.subprocess === null` (`embedded-agent-worker-service.ts`, `sendSystemNotification` L1464 → `deliverUserTurn` L1580 → `ensureDeliverable` L1692–1726 at `a3ffc100`) — an inbound event wakes a dormant embedded Orchestrator exactly as a timer tick does.

**Known boundary (not changed by #1739):** a session holding BOTH a hibernated PTY `agent` worker and an `embedded-agent` worker computes `activationState: 'hibernated'` — `computeActivationState` (`session-converter-service.ts`) reads PTY workers only — and is skipped with the "not running" reason even though its embedded worker could receive; `activationState`'s definition belongs to hibernation (Issue [#1264](https://github.com/ms2sato/agent-console/issues/1264)), and the boundary is pinned in `resolve-targets.test.ts`.

**Hibernated designated sessions are SKIPPED, never auto-removed (ruling, #1716 §5).** `activationState: 'hibernated'` is derived, not stored — it means "all PTY workers gone" (`session-converter-service.ts`) — and it is transient: the auto-resume path brings such a session back with no operator action, so an auto-removal on hibernation would silently drop a designation minutes before it became deliverable again. The only removal the system performs is the `ON DELETE CASCADE` on session deletion. A stale designation on a retired incarnation is visible in the sidebar (the flag stays lit) and is the owner's, or the retiring Orchestrator's (`clear_orchestrator_session` before retiring), to lower.

**Boundary values** (pinned in `services/inbound/__tests__/resolve-targets*.test.ts` for both paths): a row with `[]` yields no target from that row; two designated with one hibernated yields exactly the live one; two same-remote rows designating the same session yield one target; three designated, all live, yield three targets.

The shipping-path E2E for both paths is `bun scripts/smoke/check-webhook-issue-label-routing.ts` (scenarios 3–7; scenario 4c and scenario 5's session E cover the embedded-designated recipient; registered in `.claude/rules/smoke-verification-server.md`).

### Service Parser Interface

Service parsers authenticate webhooks and convert raw payloads to `InboundSystemEvent`.

```typescript
interface ServiceParser {
  /** Service identifier (e.g., 'github', 'gitlab') */
  readonly serviceId: string;

  /** Authenticate the incoming webhook request */
  authenticate(payload: string, headers: Headers): Promise<boolean>;

  /**
   * Parse raw payload into InboundSystemEvent.
   * Returns null if the event type is not supported.
   */
  parse(payload: string, headers: Headers): Promise<InboundSystemEvent | null>;
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

> **Implementation Note**: The examples below use `unknown` type for brevity. In production, define TypeScript interfaces for GitHub webhook payloads (e.g., `GitHubWorkflowRunPayload`) and add type guards to validate payload structure before property access. Return `null` for malformed payloads.

```typescript
async parse(payload: string, headers: Headers): Promise<InboundSystemEvent | null> {
  const body = JSON.parse(payload);
  const githubEvent = headers.get('x-github-event');

  switch (githubEvent) {
    case 'workflow_run':
      if (body.action !== 'completed') return null;
      return this.parseWorkflowRun(body);

    case 'issues':
      if (body.action !== 'closed') return null;
      return this.parseIssueClosed(body);

    case 'pull_request':
      return this.parsePullRequest(body);

    case 'pull_request_review_comment':
      return this.parsePullRequestReviewComment(body);

    case 'pull_request_review':
      if (body.action !== 'submitted') return null;
      return this.parsePullRequestReview(body);

    case 'issue_comment':
      if (body.action !== 'created') return null;
      return this.parseIssueComment(body);

    default:
      return null; // Unsupported event
  }
}

private parseWorkflowRun(body: unknown): InboundSystemEvent {
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

private parseIssueClosed(body: unknown): InboundSystemEvent {
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

private parsePullRequest(body: unknown): InboundSystemEvent | null {
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

private parsePullRequestReviewComment(body: unknown): InboundSystemEvent {
  return {
    type: 'pr:review_comment',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: body.repository.full_name,
      branch: body.pull_request.head.ref,
      url: body.comment.html_url,
    },
    payload: body,
    summary: `Review comment on PR #${body.pull_request.number}: ${body.comment.body.slice(0, 80)}`,
  };
}

private parsePullRequestReview(body: unknown): InboundSystemEvent | null {
  // Only handle 'changes_requested' reviews; other states (approved, commented) are ignored.
  if (body.review.state !== 'changes_requested') return null;

  return {
    type: 'pr:changes_requested',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: body.repository.full_name,
      branch: body.pull_request.head.ref,
      url: body.review.html_url,
    },
    payload: body,
    summary: `Changes requested on PR #${body.pull_request.number} by ${body.review.user.login}`,
  };
}

private parseIssueComment(body: unknown): InboundSystemEvent | null {
  // Only handle comments on pull requests, not on regular issues.
  if (!body.issue.pull_request) return null;

  return {
    type: 'pr:comment',
    source: 'github',
    timestamp: new Date().toISOString(),
    metadata: {
      repositoryName: body.repository.full_name,
      // NOTE: metadata.branch is undefined because GitHub's issue_comment event
      // does not include branch info. Events route to all sessions matching the repository.
      url: body.comment.html_url,
    },
    payload: body,
    summary: `Comment on PR #${body.issue.number}: ${body.comment.body.slice(0, 80)}`,
  };
}
```

## Generic Signed Webhook Endpoints

A message posted to Slack by a program the operator does not maintain can reach a repository's designated Orchestrator sessions without creating a GitHub Issue. The sender is a Slack dispatcher that posts a signed webhook ([Standard Webhooks](https://www.standardwebhooks.com/) headers); an endpoint is a row an operator creates under a repository. This section is the specification; endpoint management (create, edit, rotate, delete) is documented through the Surfaces table below.

### Shape

```text
POST /webhooks/in/:endpointId                                   -- RECEIVE HALF (kind-agnostic)
  -> 404 unknown endpoint
  -> 401 bad signature (current or previous secret) / stale timestamp / missing signature headers
  -> 400 invalid webhook-id / malformed body
  -> 413 oversized body (512 KB)
  -> one transaction: dedupe row (endpoint_id, webhook_id) + job row; duplicate -> 200, no job
  -> 200 accepted; 503 if the transaction fails; 500 for anything unhandled
job INBOUND_WEBHOOK_PROCESS:
  receive half  -> re-read the endpoint row (gone -> no delivery, PermanentHandlerError, the job ends stalled on the first attempt)
                -> parse the body, fetch the attachments once into memory (best effort), build DeliveryContent { bodyMarkdown (sanitized), instructionMarkdown (endpoint.instruction_text as-is), attachments, attachment counts, summary, url }
  action half   -> (kind: repository-orchestrators, the only kind today)
                   InboundSystemEvent { type: 'external:message', source: 'webhook', metadata: { targetRepositoryId, repositoryName, deliveryId, instructionExcerpt } }
                -> resolveTargets -> write body.md + instruction.md + attachments/ into each target's messages dir
                -> existing handler chain -> deliverWorkerNotification (live PTY, embedded, paused deferral)
```

**Receive half / action half.** The receive half owns everything that does not depend on who acts: endpoint lookup, signature and timestamp verification, body validation, the transactional dedupe and enqueue, the endpoint re-read at process time, and building the delivery content. The action half owns resolving targets, writing the per-target files and delivering. The seam is `DeliveryContent` plus the endpoint row; a later kind implements a different action against the same seam and never touches the receive half. It is a module boundary, not a plugin registry: `services/inbound-webhook/receive.ts` (route and job front) and `services/inbound-webhook/actions/repository-orchestrators.ts`; the job handler (`services/inbound-webhook/job-handler.ts`) calls receive then the one action, and `receive.ts` imports nothing from `actions/`.

### Sender contract and verification

- Headers `webhook-id` (stable across the sender's retries), `webhook-timestamp` (unix seconds) and `webhook-signature` (`v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`; several space-separated entries are accepted if any matches). The key is the base64-DECODED bytes of the part after `whsec_`. The signed body is the raw request text.
- Verification order: endpoint lookup, signature against `secret` and then against `previous_secret` while its expiry is strictly in the future (the same predicate the wire view uses), timestamp tolerance of plus or minus 300 s (exactly 300 s is accepted, 301 s refused), then `webhook-id` and body validation.
- `webhook-id` becomes part of a per-target directory name, so it must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; anything else is 400 and leaves no row.
- Body: a JSON object with `message` (string, possibly empty) or `slack_message` (object); other known keys are type-checked, unknown keys are ignored and missing keys are absent. The sender caps the body at 256 KB.

### Idempotency and response codes

1. Endpoint lookup, then signature, timestamp, and body validation as above; none of them leaves a row.
2. One `db.transaction()`: `INSERT ... ON CONFLICT (endpoint_id, webhook_id) DO NOTHING`; zero rows means a duplicate (200, no job); otherwise `jobQueue.enqueue(INBOUND_WEBHOOK_PROCESS, { jobId, endpointId, rawPayload, receivedAt }, { jobId, executor: trx })`. After commit `jobQueue.wake()` is called, also for a duplicate, so a job committed earlier whose wake was lost is still picked up. A throw inside the transaction persists neither row and answers 503.
3. `jobId = deliveryId = 'inbound-webhook:' + endpointId + ':' + webhookId` (deterministic, so not stored). It is also the per-target directory name and the key of the existing notification idempotency, so a retried job does not notify an already-notified target again.

| Case | Code |
|---|---|
| Unknown `:endpointId` | 404 |
| Bad signature (both secrets), stale or invalid timestamp, or missing signature headers | 401 |
| Invalid `webhook-id` or malformed body | 400 |
| Oversized body | 413 |
| Duplicate `(endpoint, webhook-id)` | 200 |
| Accepted, enqueued | 200 |
| Transaction failed | 503 |
| Unhandled exception | 500 |

The 401 body is one generic message for every signature or timestamp failure; the reason goes to the server log only. Enqueue-failure and 500 logging carries `endpointId`, `webhookId` and the error only, never `rawPayload`, the signature header or any secret.

### Delivery

- **Targets.** Every live or paused designated Orchestrator session of the bound repository receives the message, same as `issue:labeled` (fan-out); a repository-less session is never a target. Eligibility is the same classification the other designated routes use (`classifyOrchestratorSession`): not live, not running, or without an agent-shaped worker is excluded with an info log naming `external:message`; a paused session is a deferred target and gets one digest row. The routing branch precedes the `repositoryName` guard in `resolveTargets` and makes exactly one `collectRoutableSessions()` call per event.
- **Notification: fields only.** No sender text and no multi-line operator text appears in the notification, ever, and there is no `body` parameter for this kind. The fields, each value through `formatFieldValue`: `type, source, repo, branch ('N/A'), url (slack permalink or 'N/A'), summary (sender text collapsed to one line, about 160 characters), instruction_excerpt (first non-empty line of the instruction, at most 120 characters), instruction_path, body_path, intent ('triage')`. `instruction.md` is the operator-trusted file; `body.md` is the untrusted sender file; the notification tells the agent which is which by field name. What limits an injected instruction is structural: the blast radius is one repository chosen by the admin, and the operator's instruction sets how the body is treated. This is recorded as accepted risk. The operator's instruction should say to coordinate via `send_session_message` before an action with side effects, since every eligible designated session may act on the same message.
- **Files.** Written by the action half before delivery, once per target, into `{messagesDir}/{sessionId}/{workerId}/inbound-webhook/{deliveryId}/` through the trusted-directory writer (`lib/trusted-file-write.ts`, the same ancestor-contract walk the inter-session message files use): the files inherit the `2775` data-root contract (readable by the session's OS user in multi-user mode) and session deletion already removes `messages/<sessionId>`. A paused session's deferred row references the paths and the files outlive any pause. `body.md` is a sanitized projection (`message`, `slack_permalink`, `slack_channel` / `slack_ts`); `slack_message` and `slack_files[].url` are never written to any session-visible file. `instruction.md` is `instruction_text` as stored at process time, byte for byte (the endpoint row is re-read, so an edit between receipt and processing is honoured). A write failure for one target drops only that target.
- **Deleted endpoint.** The job handler re-reads the endpoint; if it is gone (deleted, or cascade-deleted with its repository) the handler throws `PermanentHandlerError` and the queue ends the job `stalled` at the first attempt, without delivering and without retries.

### Attachments

The sender's `slack_files` entries (`{name, mimetype, size, url}`) are short-lived download-token URLs (objects are deleted at the source after about a day), so the receive half fetches them when the job runs, before anything reaches a session. Everything about them is best effort: a file that cannot be fetched is skipped and counted, never retried, and never blocks the body.

- **Host pin.** The only host is `firebasestorage.googleapis.com`, hardcoded in `services/inbound-webhook/attachments.ts` and not configurable, so no setting can widen where the server connects. The URL must parse, use `https`, have a hostname exactly equal to the pin (no suffix match, no substring match), carry no user name or password, and use the default port; anything else is skipped without any network call. The hostname is compared after URL parsing, so host case does not matter and an explicit `:443` is accepted; what is checked is what is fetched.
- **Redirects.** The fetch is made with `redirect: 'manual'`; any 3xx or other non-2xx answer is a skip, never followed.
- **Caps.** Per-file timeout 10 s, per-file size 25 MiB, at most 10 files per message, as injectable limits whose defaults live in `server-config.ts` (`INBOUND_WEBHOOK_ATTACHMENT_TIMEOUT_MS`, `INBOUND_WEBHOOK_ATTACHMENT_MAX_BYTES`, `INBOUND_WEBHOOK_ATTACHMENT_MAX_COUNT`). The size cap is enforced on the declared size, on `Content-Length`, and while streaming: the reader is cancelled the moment the running total passes the cap. Files beyond the count cap are not attempted and are counted as skipped.
- **Token handling.** The download-token URL is read once and discarded. It appears in no `DeliveryContent` field, no written file, no notification field, no thrown error text and no log line (a failing fetch is logged by reason code and position only). Session-visible files carry only local file names.
- **One fetch, one copy per target.** Each file is fetched once into memory by the receive half and copied per target by the action half into `{messagesDir}/{sessionId}/{workerId}/inbound-webhook/{deliveryId}/attachments/<name>` through the same trusted-directory writer as the other files. `body.md` lists the local names as relative paths (`attachments/<name>`) and the number not fetched; there is no separate notification field carrying the directory.
- **File names.** The sender's name becomes a path inside a directory, so only its last path component survives (split on `/` and `\`), control, line-separator, bidi and zero-width characters are removed, an empty or dots-only name becomes `attachment`, a name is capped at 100 code points and 240 UTF-8 bytes (the stem is shortened, the extension kept, a surrogate pair is never split), and collisions are numbered before the extension (`a.png`, `a-2.png`), compared case-insensitively. The declared mimetype is never used to build a name.
- **Counts.** `attachments_fetched` and `attachments_skipped` are notification fields rendered after `body_path`, only when the message listed files (a message without `slack_files` keeps the exact text it had before attachments existed); `fetched + skipped` equals the number of files listed. The counts are event-level, from the one fetch: a per-target write failure for one attachment is logged (ids and position only) and does not change them.
- **Verification.** The success path (pin, caps, redirect, timeout, per-target copies, token absence) is exercised in-process through the real job handler with an injected fetch, because the pin forbids reaching any other host from a test; the shipping-path smoke covers the offline refusal arm (a non-allowlisted host is skipped without any network call while the body still delivers).

### Data at rest (accepted)

- `jobs.payload` holds the dispatcher's raw body verbatim (including `slack_files[].url` and `slack_message`) for as long as the job row exists. Completed rows are deleted by the queue's retention sweep after `JOB_COMPLETED_RETENTION_DAYS` (default 30 days; see `local-job-queue-design.md`); `stalled` rows are kept until a person retries or cancels them. The token itself is valid for about 1 day at Firebase.
- Logs never carry the payload (above). Session-visible files never carry the token (above).

### Operator contract

- Only the webhook paths are exposed to the internet. The receive URL shown in the UI, `<internet origin>/webhooks/in/<id>`, is built from the optional server setting `AGENT_CONSOLE_INTERNET_ORIGIN` (exposed as `internetOrigin` on `GET /api/system/health`): it must be the internet-facing origin that the reverse proxy routes to this server, never `AGENT_CONSOLE_PUBLIC_ORIGIN` or `APP_URL`, which are human-facing.
- The reverse proxy must forward `/webhooks/in/*` (today only `/webhooks/github` may be exposed); a missing route answers 404, which the dispatcher treats as a permanent loss. **Register a URL in the dispatcher only after that forwarding is in place.**
- During a deploy the proxy must answer a 5xx (for example 502, 503, or Cloudflare Tunnel's 530) or refuse the connection on this path; a page answering 200, 401 or 404 loses the message permanently. The dispatcher retries on timeout, connection failure, 408, 429 and 5xx; other 4xx and 3xx are permanent. A secret mismatch is a permanent 401, so rotation updates the receiver first: rotate here, paste the new value into the dispatcher, let the 24 h previous-secret window close.

### Surfaces: decision table

Owner-confirmed 2026-11-07. Decision-table checklist (`.claude/rules/decision-table.md`): this table has no undecided cell; the implementation matches every "do" cell and exposes nothing marked "not here".

Rows are operations on an endpoint; columns are surfaces. Every cell is a recorded decision (`.claude/rules/decision-table.md`). The MCP and embedded-visible columns are one owner ruling applied per row (no MCP tool; secrets stay off every agent-visible surface and endpoint management is an operator action), written once here and referenced as "operator-only". The whole repository-page column, including every cell marked **(owner)**, was confirmed by the owner on 2026-11-07 (TODO 09d1465c); the marks stay as the record of which cells were decided by the Architect or the implementer rather than by an earlier AC.

UI placement decision: a sibling route `/settings/repositories/$repositoryId/inbound-webhooks` (the list), reached from the repository detail page (`/settings/repositories/$repositoryId/`) by a link next to Edit, with the repository in the breadcrumb. Not inside the Edit page: that page is one `react-hook-form` with a single Save, while endpoint operations are immediate mutations with a one-time secret panel; nesting a list with its own buttons inside a form invites submit confusion (the Slack integration lives in the form because it is one record saved with the form; endpoints are a collection).

Edit and create are each their own page (owner decision for edit; create follows for consistency AND because the create form now carries the generate/enter choice and a secret input, which belongs on a page, not above a list): `.../inbound-webhooks/new` and `.../inbound-webhooks/$endpointId/edit`, both using one `EndpointForm` (label, instruction textarea; the create variant adds the secret-source choice). After a successful create with a generated secret the create page itself shows the one-time panel in place of the form, with a "Done" link back to the list; the secret never crosses a navigation. Rotate stays on the list page as a row action that opens a small dialog with the same generate/enter choice; a generated secret shows in the panel on the list page as today.

Entered-secret handling in the client: the secret input is `type="password"` with `autoComplete="off"`, lives only in the form's local state, is cleared on submit and on unmount, and is not passed as a `useMutation` variable (TanStack keeps `variables` in mutation state while observed): the mutation function receives it through a ref/closure argument, the mutations keep `gcTime: 0` and call `reset()` on settle. A test asserts the mutation cache holds no entry carrying the entered string after settle.

| Operation | REST (`/api/repositories/:repositoryId/inbound-webhook-endpoints`, authenticated caller) | Repository settings page (`/settings/repositories/$repositoryId/inbound-webhooks`) | MCP | Embedded-visible |
|---|---|---|---|---|
| list (one repository) | do: `GET /` (unknown repository -> 404) | do: endpoint rows (`EndpointRow`), every non-secret field **(owner)** | not here: operator-only | not here: operator-only |
| list across repositories | not here: owner decision 1, an endpoint is wholly owned by one repository; no global list, no global page | not here: same | not here: same | not here: same |
| get | do: `GET /:id` (other repository's id -> 404) | not here: the row already shows every non-secret field; no detail page **(owner)** | not here: operator-only | not here: operator-only |
| create | do: `POST /` (201; body `{ label, instructionText, secret? }`; response carries a generated `secret` once, never an entered one) | do: own page `.../inbound-webhooks/new` (`EndpointForm`: label, instruction textarea, secret source choice "Generate" default / "Enter my own"); a generated secret shown once on that page in `SecretRevealPanel` with Copy, then Done -> list **(owner)** | not here: operator-only | not here: operator-only |
| update (label, instruction text) | do: `PATCH /:id`; `repositoryId` / `secret` in the body are 400 | do: own page `.../inbound-webhooks/$endpointId/edit` (`EndpointForm` without the secret choice), reached by Edit on the row; Save returns to the list **(owner)** | not here: operator-only | not here: operator-only |
| rebind repository | not here: ruling below (fixed after creation) | not here: same | not here: same | not here: same |
| delete | do: `DELETE /:id` (deliveries cascade) | do: Delete on the row behind a `ConfirmDialog` naming the consequence (senders stop being accepted) **(owner)** | not here: operator-only | not here: operator-only |
| rotate secret | do: `POST /:id/rotate-secret` (optional body `{ secret? }`; response carries a generated `secret` once, never an entered one) | do: Rotate on the row opens a dialog with the generate/enter choice; a generated secret shown once in `SecretRevealPanel` on the list page; every Rotate is disabled while a rotate is pending or an issued secret is unsaved (dismiss re-enables) **(owner)** | not here: operator-only | not here: operator-only |
| enter own secret (create, rotate) | do: `secret?` on both bodies, validated `whsec_` + base64 of 24..64 bytes, 400 otherwise with a value-free message; response `secretSource: 'entered'` and no secret | do: "Enter my own" on the create page and in the rotate dialog, password input, held only for the request; no panel afterwards, the row shows nothing about the source **(owner)** | not here: operator-only | not here: operator-only |
| clear previous secret | do: `POST /:id/clear-previous-secret` | do: "End previous secret now" on the row, rendered only while `hasPreviousSecret` **(owner)** | not here: operator-only | not here: operator-only |
| show receive URL (`<base>/webhooks/in/<id>`) | do: base via `GET /api/system/health` `internetOrigin` (null when `AGENT_CONSOLE_INTERNET_ORIGIN` is unset); no URL field on the endpoint resources | do: on each list row and on the create page's post-create panel, with Copy; path plus a hint when the base URL is unset **(owner)** | not here: operator-only (the agent never needs the sender's URL) | not here: operator-only |
| reveal secret (read back after issue) | not here: owner ruling 2026-11-07, lost secret means rotate | not here: same | not here: same | not here: same |
| receive a message (`POST /webhooks/in/:endpointId`) | not here: this route is a public, signature-verified route outside `/api` (sender surface, not an authenticated caller) | not here: nothing to operate; delivery reaches sessions through the notification path | not here: same | not here: same |

**Rulings on the implementer's decisions (design decisions, 2026-11-07; unchanged by the revision unless noted):**

- **Create on its own page, like edit.** Decided by the Architect under the owner's edit-page decision: consistency, and the create form now holds a secret-source choice and a secret input, which should not sit above a list. The list page keeps only row actions (Edit link, Rotate dialog, End previous, Delete).
- **Repository fixed after creation (PATCH edits label and instruction only).** Confirmed; now also structural, since the endpoint lives under its repository's URL. Rebinding would silently redirect a sender to another repository's Orchestrators and carry the dedupe ledger across repositories; changing the target is delete + create, which forces a new secret into the dispatcher.
- **Blank or whitespace-only `instructionText` is 400, and the value is not trimmed.** Confirmed (the newline rejection is gone; blank still has no purpose).
- **`previousSecretExpiresAt` reads null once expired and `hasPreviousSecret` is true only while unexpired.** Confirmed; the receive verifier uses the same strictly-future predicate.
- **Interface file `repositories/webhook-endpoint-repository.ts`.** Confirmed (keeps `test-trigger.md`'s interface-only exemption).
- **Unknown repository is 404, missing is 400.** Revised by the move: the repository is now a path segment, so "missing" cannot occur; an unknown `:repositoryId` is 404 `Repository` on list and create, and an id-scoped route for an endpoint not in that repository is 404 `Inbound webhook endpoint`.

### Non-goals

- A "launch" endpoint kind (start an agent with a prompt, not bound to one repository, possibly creating worktrees across repositories) is out of scope. When built, it is NOT represented as `repository_id IS NULL` on `inbound_webhook_endpoints`: it gets its own table, or a `kind` column with per-kind CHECKs, decided then. The receive/action split above is what that kind plugs into.
- No templates or transformation of the sender's body; the first version projects fields only.

## Configuration

### Handler Registration

```typescript
interface InboundIntegrationConfig {
  /** Enabled handlers and their event subscriptions */
  handlers: {
    'agent-worker': {
      enabled: boolean;
      events: InboundEventType[];
    };
    'diff-worker': {
      enabled: boolean;
      events: InboundEventType[];
    };
    'ui-notification': {
      enabled: boolean;
      events: InboundEventType[];
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

## Implementation Plan

1. **Shared types and protocol updates**
   - Add `InboundEventType`, `SystemEvent`, and `EventTarget` types under `packages/shared/src/types` (new `system-events.ts` or augment existing shared types).
   - Extend `AppServerMessage` with `inbound-event` payload and document it in `docs/design/websocket-protocol.md`.
2. **Database + repository layer**
   - Add `inbound_event_notifications` table to `packages/server/src/database/schema.ts` and migration v11 in `packages/server/src/database/connection.ts`.
   - Implement a repository for `inbound_event_notifications` with `create()` and `listBySession/Worker()` queries.
3. **Inbound job + handler**
   - Add `inbound-event:process` to `packages/server/src/jobs/job-types.ts` and register a handler in `packages/server/src/jobs/handlers.ts` that:
     - rehydrates headers, parses the event, resolves targets, runs handlers, and writes notification history.
4. **Service parsers + routing**
   - Create `packages/server/src/services/inbound` with `ServiceParser` interface and `GitHubServiceParser` implementation (signature auth + event parsing).
   - Add `POST /webhooks/github` route in `packages/server/src/routes` and mount in `packages/server/src/index.ts`.
5. **Target resolution and handlers**
   - Implement `resolveTargets()` using session + repository managers (runtime `git remote get-url origin`).
   - Add handlers: `AgentWorkerHandler`, `DiffWorkerHandler`, `UINotificationHandler`, and a registry to filter by event type.
6. **Client UI handling**
   - Update `packages/client/src/hooks/useAppWs.ts` and any relevant UI to surface inbound event notifications.
7. **Configuration + tests**
   - Add `GITHUB_WEBHOOK_SECRET` to `packages/server/src/lib/server-config.ts` and update env filtering if needed.
   - Add tests for webhook auth + parsing, job handler processing, and UI message handling.

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
  readonly supportedEvents: InboundEventType[] = ['issue:closed', 'pr:merged'];

  async handle(event: InboundSystemEvent, target: EventTarget, _opts: InboundHandleOptions): Promise<HandlerOutcome> {
    // Example: Show dialog suggesting to close session
    if (event.type === 'issue:closed' || event.type === 'pr:merged') {
      this.appWebSocket.broadcast({
        type: 'session-action-suggestion',
        sessionId: target.sessionId,
        action: 'archive',
        reason: event.summary,
      });
      return 'handled';
    }
    return 'not-applicable';
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
