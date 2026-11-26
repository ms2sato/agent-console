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
                -> parse the body, fetch the attachments once into memory (best effort), build DeliveryContent { bodyMarkdown (sanitized; includes the Slack content projection), instructionMarkdown (endpoint.instruction_text as-is), attachments, attachment counts, summary, url }
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
- Body: a JSON object with `schema_version: 2` ("Body versions" below). Unknown keys are ignored at every level. The sender caps the body at 256 KB.

### Body versions

The body is parsed ONCE, by `parseInboundWebhookBody` in `services/inbound-webhook/receive.ts`, into one neutral internal shape (`InboundMessage`: schema version, message, permalink, channel, timestamp, files, source event, sender-truncated flag). Everything downstream (the body projection, the summary, the attachments, the log record) reads that shape and never a body key. Exactly one body version is read. Dispatch is on `schema_version` of the JSON object:

| `schema_version` in the JSON object | Result | `schemaVersion` on the `Inbound webhook refused` record |
|---|---|---|
| `2` (also `2.0`) | read by the reader below; if its schema fails, 400, reason `invalid-request` (`unsupported-schema-version` for `hikyac.v`, see the key table) | not present (`2` for `hikyac.v`) |
| key absent | 400, reason `unsupported-schema-version` | not present |
| `1` (also `1.0`) | 400, reason `unsupported-schema-version` | `1` |
| any other finite number (`0`, `3`, `1.5`, `-1`) | 400, reason `unsupported-schema-version` | that number |
| not a number (`"2"`, `null`, `true`, object) | 400, reason `unsupported-schema-version` | not present |
| body is not JSON, or JSON that is not a plain object | 400, reason `invalid-request` | not present |

The sender treats 400 as permanent (no retry). Both reasons answer 400 and leave no deliveries row and no job; the reason goes to the `Inbound webhook refused` warn record, and for `unsupported-schema-version` that record also carries `schemaVersion` when the received value is a finite number (a non-number value is never logged).

**Reader** (non-strict objects, so the sender may add keys within a version):

| Key | Requirement | Missing / wrong type |
|---|---|---|
| `message` | string, required (empty allowed) | refused |
| `hikyac` | object, required | refused |
| `hikyac.v` | exactly `1` | refused, reason `unsupported-schema-version` |
| `hikyac.permalink` | string or null, required | refused |
| `hikyac.files` | array of `{name?, mimetype?, size?, url?}`, required; `[]` = no files | refused |
| `hikyac.reply`, `.triggers`, `.thread_key` | not declared, not read | ignored |
| `source` | object with string `type`, required | refused |
| `source.type === "slack"` | `ids.channel` string, `ids.ts` string, `event` object or null, `truncated` boolean, all required; other `ids` keys ignored | refused |
| `source.type` any other string | `ids`, `event`, `truncated` are not read at all | delivered with message, permalink and files only: no Channel / Timestamp lines, no `## Content`, no poster ids |

Mapping: `message` -> message, `hikyac.permalink` -> permalink, `source.ids.channel` -> channel, `source.ids.ts` -> timestamp, `hikyac.files` -> files (same pinned attachment host), `source.event` -> source event, `source.truncated` -> sender-truncated flag. The reply address the sender puts in the body (`hikyac.reply`) is not read by this receiver at all: it reaches no session-visible file, notification, summary or log line.

### Idempotency and response codes

1. Endpoint lookup, then signature, timestamp, and body validation as above; none of them leaves a row.
2. One `db.transaction()`: `INSERT ... ON CONFLICT (endpoint_id, webhook_id) DO NOTHING`; zero rows means a duplicate (200, no job); otherwise `jobQueue.enqueue(INBOUND_WEBHOOK_PROCESS, { jobId, endpointId, rawPayload, receivedAt }, { jobId, executor: trx })`. After commit `jobQueue.wake()` is called, also for a duplicate, so a job committed earlier whose wake was lost is still picked up. A throw inside the transaction persists neither row and answers 503.
3. `jobId = deliveryId = 'inbound-webhook:' + endpointId + ':' + webhookId` (deterministic, so not stored). It is also the per-target directory name and the key of the existing notification idempotency, so a retried job does not notify an already-notified target again.

| Case | Code |
|---|---|
| Unknown `:endpointId` | 404 |
| Bad signature (both secrets), stale or invalid timestamp, or missing signature headers | 401 |
| Invalid `webhook-id`, malformed body, or unsupported `schema_version` | 400 |
| Oversized body | 413 |
| Duplicate `(endpoint, webhook-id)` | 200 |
| Accepted, enqueued | 200 |
| Transaction failed | 503 |
| Unhandled exception | 500 |

The 401 body is one generic message for every signature or timestamp failure; the reason goes to the server log only. Enqueue-failure and 500 logging carries `endpointId`, `webhookId` and the error only, never `rawPayload`, the signature header or any secret.

### Delivery

- **Targets.** Every live or paused designated Orchestrator session of the bound repository receives the message, same as `issue:labeled` (fan-out); a repository-less session is never a target. Eligibility is the same classification the other designated routes use (`classifyOrchestratorSession`): not live, not running, or without an agent-shaped worker is excluded with an info log naming `external:message`; a paused session is a deferred target and gets one digest row. The routing branch precedes the `repositoryName` guard in `resolveTargets` and makes exactly one `collectRoutableSessions()` call per event.
- **Notification: fields only.** No sender text and no multi-line operator text appears in the notification, ever, and there is no `body` parameter for this kind. The fields, each value through `formatFieldValue`: `type, source, repo, branch ('N/A'), url (slack permalink or 'N/A'), summary (sender text collapsed to one line, about 160 characters: `message`, or the first projected content line when `message` is empty), next_step (a fixed server string, see below), instruction_excerpt (first non-empty line of the instruction, at most 120 characters), instruction_path, body_path, intent ('triage')`. `next_step` is a fixed server constant (neither sender text nor operator text) that tells the agent to read the instruction file in full before acting and to treat the body as data; it is why the excerpt is safe to keep as a human cue, because an agent that reads only the notification line is still told to open the instruction. It is carried by `external:message` only, travels inside the stored params, and so also appears in a resume digest line; a row deferred before this field existed renders without it and is not backfilled. `instruction.md` is the operator-trusted file; `body.md` is the untrusted sender file; the notification tells the agent which is which by field name. What limits an injected instruction is structural: the blast radius is one repository chosen by the admin, and the operator's instruction sets how the body is treated. This is recorded as accepted risk. The operator's instruction should say to coordinate via `send_session_message` before an action with side effects, since every eligible designated session may act on the same message.
- **Files.** Written by the action half before delivery, once per target, into `{messagesDir}/{sessionId}/{workerId}/inbound-webhook/{deliveryId}/` through the trusted-directory writer (`lib/trusted-file-write.ts`, the same ancestor-contract walk the inter-session message files use): the files inherit the `2775` data-root contract (readable by the session's OS user in multi-user mode) and session deletion already removes `messages/<sessionId>`. A paused session's deferred row references the paths and the files outlive any pause. `body.md` is a sanitized projection of the normalised message ("Body versions" above): the message text, the permalink, the channel and timestamp, a text-only projection of the source event's `blocks` / `attachments` (the "Slack content projection" below), and the poster's `app_id` / `bot_id` from the source event when each matches the id shape (the "Poster identity" paragraph below). The source event itself (`source.event`), every other key of it besides those two ids, and the file entries' `url` (`hikyac.files[].url`) are never written to any session-visible file. `instruction.md` is `instruction_text` as stored at process time, byte for byte (the endpoint row is re-read, so an edit between receipt and processing is honoured). A write failure for one target drops only that target.
- **Deleted endpoint.** The job handler re-reads the endpoint; if it is gone (deleted, or cascade-deleted with its repository) the handler throws `PermanentHandlerError` and the queue ends the job `stalled` at the first attempt, without delivering and without retries.

### Slack content projection

The source event is the body's `source.event` ("Body versions" above). A sender that formats with Block Kit carries its readable content in `source.event.blocks` (legacy senders: `source.event.attachments`), not in `message`. `body.md` therefore carries a text-only projection of those two arrays in a `## Content` section, between `## Message` and `## Details`. It is a projection, not a dump: only strings found in the positions listed below are written, each through the same sanitiser as `## Message`; no other key of `source.event` reaches a session-visible file, except the two poster ids described under "Poster identity" below. The receiver only displays this text and never derives counts, severity or routing from it.

Projection table (`.claude/rules/decision-table.md`: every cell is a decision; none is left to the implementer). A "text object" is any object whose `text` is a string; its `type`, `emoji`, `verbatim` and every other key are ignored. A text that is empty or whitespace-only after sanitising counts as absent, wherever it appears (a block whose only text is blank is therefore "not shown, counted", and no blank line is written for a blank field).

| Source | Rendering in `## Content` |
|---|---|
| block `header` | `### ` + `text.text` on one line (`toSingleLine`); no text object -> not shown, counted |
| block `section` | `text.text`, then each `fields[]` text object on its own line, in order; none present -> not shown, counted |
| block `context` | each `elements[]` text object on its own line, in order; other elements (images) ignored; none present -> not shown, counted |
| block `divider` | a `---` line; never counted |
| block `rich_text` | not shown, NOT counted (Slack mirrors composer-written content in `text`, shown under `## Message`) |
| any other block type, a block without a string `type`, a non-object entry | not shown, counted |
| `attachments[]` entry (legacy) | after all blocks, one chunk per attachment: `pretext`, `title`, `text`, each `fields[]` entry as `title: value` (either part alone if the other is absent), then its own `blocks[]` by the rows above; if none of those yields text, `fallback`; if nothing at all -> not shown, counted. `footer`, author, links, colours, images, actions are never read |
| `source.event.text` | not projected (it is `message`) |
| mrkdwn tokens and entities (`<url\|label>`, `<!channel>`, `<@U..>`, `&lt;` `&gt;` `&amp;`) | verbatim: no decoding, no rewriting |
| control characters | `sanitizeMultiline` (keeps `\n` and `\t`), as in `## Message` |
| more than 65,536 UTF-8 bytes of projected text | cut at a code-point boundary at or below the cap; exactly the cap is not cut; notice line |
| `source.truncated: true` | section rendered even with no text; notice line. (The sender drops `source.event`, wholly or partly, when its body would pass its own size cap; the rendering is the same either way.) |
| nothing projected, nothing counted, flag absent or false, and neither poster id shown | no `## Content` section and no id line; `body.md` is byte-identical to a message whose `source.event` is null |
| `source.event.blocks` / `.attachments` absent or not an array | treated as empty |
| a malformed block or attachment | counted as not shown; never an error, never a failed delivery |

Layout: chunks are separated by one blank line; lines inside a chunk by `\n`. The section is, in order: the heading; the fixed line `Slack mrkdwn, verbatim. &lt; &gt; &amp; are escaped characters; <!channel>, <@U...> and <url|label> are Slack tokens.`; the chunks; then, each only when it applies and in this order, `(Content cut at 65536 bytes.)`, `(N block(s) without projectable text not shown.)`, `(The sender shortened the Slack message to fit its size limit; content may be missing.)`.

Summary: when `message` is empty after whitespace collapsing, the notification `summary` is the first non-empty projected line (a divider and the fixed lines are not candidates), through the same cut; otherwise it is `message` as before.

Poster identity: one endpoint can receive messages that different Slack apps posted, and the operator's instruction text needs to branch on which one did. `body.md` therefore shows the poster's `source.event.app_id` and `source.event.bot_id` (top level only; nothing else of the poster, not `bot_profile.*`, `username`, `user`, `subtype` or `team`) as `- App ID: <value>` then `- Bot ID: <value>` under `## Details`, after `- Timestamp:`. `app_id` is the marker to branch on, because it survives app and channel renames; `bot_id` is shown so a poster without an app is still distinguishable, and it is not stable across reinstalls. A value is shown only when it is a string that matches `/^[A-Z0-9]{1,32}$/` exactly as received: no trim, no case folding, and no sanitiser pass, because the pattern leaves nothing to sanitise. Anything else (not a string, null, empty, lower case, 33 or more characters, any other character including a space or newline) omits that line, with no placeholder, and the other id is unaffected. An absent line therefore means "poster unknown", and the instruction text must name a default branch for it. `## Details` is rendered when at least one of its five lines exists. The ids appear in `body.md` only: never in the notification, its `summary` or `instruction_excerpt`, or any wire frame, and the log carries their kinds, never their values. Trust: the ids are sender data inside a signed body, as trustworthy as the sender and checked for shape only. The receiver displays them and never routes on them.

Logging: one `info` record (`Slack content projected`) per processed delivery, whether or not it carries a source event, counts and kinds only (`schemaVersion` (always 2), `blocksSeen`, `attachmentsSeen`, `chunks`, `notShown`, `cut`, `senderTruncated`, and `appId` / `botId` each one of `shown`, `absent`, `rejected`) with the delivery id; never text and never an id value. `blocksSeen` / `attachmentsSeen` count top-level entries. An attachment that renders nothing counts as one not-shown entry, whatever it contains; when it does render, each of its nested blocks that is not shown adds one.

Surfaces: this adds no operation on any surface; the Surfaces table above is unchanged.

### Attachments

The sender's file entries (`hikyac.files`, each `{name, mimetype, size, url}`) are short-lived download-token URLs (objects are deleted at the source after about a day), so the receive half fetches them when the job runs, before anything reaches a session. Everything about them is best effort: a file that cannot be fetched is skipped and counted, never retried, and never blocks the body.

- **Host pin.** The only host is `firebasestorage.googleapis.com`, hardcoded in `services/inbound-webhook/attachments.ts` and not configurable, so no setting can widen where the server connects. The URL must parse, use `https`, have a hostname exactly equal to the pin (no suffix match, no substring match), carry no user name or password, and use the default port; anything else is skipped without any network call. The hostname is compared after URL parsing, so host case does not matter and an explicit `:443` is accepted; what is checked is what is fetched.
- **Redirects.** The fetch is made with `redirect: 'manual'`; any 3xx or other non-2xx answer is a skip, never followed.
- **Caps.** Per-file timeout 10 s, per-file size 25 MiB, at most 10 files per message, as injectable limits whose defaults live in `server-config.ts` (`INBOUND_WEBHOOK_ATTACHMENT_TIMEOUT_MS`, `INBOUND_WEBHOOK_ATTACHMENT_MAX_BYTES`, `INBOUND_WEBHOOK_ATTACHMENT_MAX_COUNT`). The size cap is enforced on the declared size, on `Content-Length`, and while streaming: the reader is cancelled the moment the running total passes the cap. Files beyond the count cap are not attempted and are counted as skipped.
- **Token handling.** The download-token URL is read once and discarded. It appears in no `DeliveryContent` field, no written file, no notification field, no thrown error text and no log line (a failing fetch is logged by reason code and position only). Session-visible files carry only local file names.
- **One fetch, one copy per target.** Each file is fetched once into memory by the receive half and copied per target by the action half into `{messagesDir}/{sessionId}/{workerId}/inbound-webhook/{deliveryId}/attachments/<name>` through the same trusted-directory writer as the other files. `body.md` lists the local names as relative paths (`attachments/<name>`) and the number not fetched; there is no separate notification field carrying the directory.
- **File names.** The sender's name becomes a path inside a directory, so only its last path component survives (split on `/` and `\`), control, line-separator, bidi and zero-width characters are removed, an empty or dots-only name becomes `attachment`, a name is capped at 100 code points and 240 UTF-8 bytes (the stem is shortened, the extension kept, a surrogate pair is never split), and collisions are numbered before the extension (`a.png`, `a-2.png`), compared case-insensitively. The declared mimetype is never used to build a name.
- **Counts.** `attachments_fetched` and `attachments_skipped` are notification fields rendered after `body_path`, only when the message listed files (a message without file entries keeps the exact text it had before attachments existed); `fetched + skipped` equals the number of files listed. The counts are event-level, from the one fetch: a per-target write failure for one attachment is logged (ids and position only) and does not change them.
- **Verification.** The success path (pin, caps, redirect, timeout, per-target copies, token absence) is exercised in-process through the real job handler with an injected fetch, because the pin forbids reaching any other host from a test; the shipping-path smoke covers the offline refusal arm (a non-allowlisted host is skipped without any network call while the body still delivers).

### Data at rest (accepted)

- `jobs.payload` holds the dispatcher's raw body verbatim (including the file entries' `url`, the source event and the reply address, which no code reads) for as long as the job row exists. Completed rows are deleted by the queue's retention sweep after `JOB_COMPLETED_RETENTION_DAYS` (default 30 days; see `local-job-queue-design.md`); `stalled` rows are kept until a person retries or cancels them. The token itself is valid for about 1 day at Firebase.
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
| set / change reply URL | do: `POST /` (optional `replyUrl`), `PATCH /:id` (`replyUrl: string`) | do: "Reply URL (optional)" input in `EndpointForm`, create and edit pages **(owner)** | not here: operator-only | not here: operator-only |
| clear reply URL | do: `PATCH /:id` with `replyUrl: null` | do: emptying the input and saving sends `null` **(owner)** | not here: operator-only | not here: operator-only |
| read reply URL | do: `replyUrl` on list / get / patch responses | do: prefilled in the edit form; the list row shows only "Replies enabled" when set, nothing when unset **(owner)** | not here: the agent never needs the sender's URL | not here: same |
| send a reply | not here: an operator has no delivery to answer; replies are an agent action | not here: same | do: `reply_to_inbound_webhook` (see "Signed replies") | do: the same MCP tool (embedded agents reach it through the same MCP server) |
| resend a reply (same id) | not here: same | not here: same | do: `reply_to_inbound_webhook` with `replyId` | do: same |
| list / read past replies | not here: no reader in this version; the per-attempt log record is the audit trail | not here: same | not here: same | not here: same |
| read the signature or the secret | not here: never leaves the server | not here: same | not here: same | not here: same |
| receive a message (`POST /webhooks/in/:endpointId`) | not here: this route is a public, signature-verified route outside `/api` (sender surface, not an authenticated caller) | not here: nothing to operate; delivery reaches sessions through the notification path | not here: same | not here: same |

**Rulings on the implementer's decisions (design decisions, 2026-11-07; unchanged by the revision unless noted):**

- **Create on its own page, like edit.** Decided by the Architect under the owner's edit-page decision: consistency, and the create form now holds a secret-source choice and a secret input, which should not sit above a list. The list page keeps only row actions (Edit link, Rotate dialog, End previous, Delete).
- **Repository fixed after creation (PATCH edits label and instruction only).** Confirmed; now also structural, since the endpoint lives under its repository's URL. Rebinding would silently redirect a sender to another repository's Orchestrators and carry the dedupe ledger across repositories; changing the target is delete + create, which forces a new secret into the dispatcher.
- **Blank or whitespace-only `instructionText` is 400, and the value is not trimmed.** Confirmed (the newline rejection is gone; blank still has no purpose).
- **`previousSecretExpiresAt` reads null once expired and `hasPreviousSecret` is true only while unexpired.** Confirmed; the receive verifier uses the same strictly-future predicate.
- **Interface file `repositories/webhook-endpoint-repository.ts`.** Confirmed (keeps `test-trigger.md`'s interface-only exemption).
- **Unknown repository is 404, missing is 400.** Revised by the move: the repository is now a path segment, so "missing" cannot occur; an unknown `:repositoryId` is 404 `Repository` on list and create, and an id-scoped route for an endpoint not in that repository is 404 `Inbound webhook endpoint`.

### Signed replies

Some senders accept a reply to a delivery: an HTTP POST to a sender-side URL, signed with the same endpoint secret and the same scheme. A session agent cannot read the secret, and a signature handed back to it would be a valid signature under the receive secret. So the server signs and sends on the agent's behalf and never returns the signature. This feature shipped in two steps: the reply URL setting (column, table, wire schema, REST, UI) and then the reply path (signing helper, reply service, MCP tool, notification field, reflection guard). Both exist in code; the rulings below are their specification.

**R1. Reply URL (operator-set, per endpoint).**

- A nullable column `reply_url` on `inbound_webhook_endpoints`. NULL means replies are refused for this endpoint.
- It is set and cleared on the existing endpoint surfaces only: `POST /` (create, optional), `PATCH /:id` (`replyUrl: string | null`; `null` clears; omitted leaves it unchanged) and the `EndpointForm` on the create and edit pages. No MCP tool reads or writes it. "Admin-only" here means the existing authenticated-caller check on REST and no agent-visible surface.
- Validation is one schema, `InboundWebhookReplyUrlSchema`, in the shared schema file, used by create and update (client and server share it):
  - a string of 1..2048 characters (`.length`), with no leading or trailing whitespace (the value is not trimmed: surrounding whitespace is 400);
  - it parses with `new URL(value)`, its protocol is exactly `https:`, its `username` and `password` are empty, and the text starts with `https://` followed by a host character (case-insensitive scheme; so `https:///x`, `https:x`, `https:/x` and backslash forms are refused, because the stored text must show the host that is called). It contains no `#` (a raw `#` is the fragment delimiter, an empty one included) and no control character (`\p{Cc}`: C0, DEL and C1);
  - query strings, ports and any hostname (including `localhost` and IP literals) are accepted. The field is operator-set, and a hostname filter would be a name-time check that the later connect does not repeat, so it would add no boundary.
  - The validation message never echoes the value (the API error handler logs messages), as for the secret schema.
- The stored value is the string as entered (not `URL#href`-normalized).
- **Placeholder.** The path may carry exactly one placeholder, `{{in_reply_to}}` (the constant `INBOUND_WEBHOOK_REPLY_URL_IN_REPLY_TO_PLACEHOLDER` in the shared types; a closed set, a new one needs a new ruling). It must occur once, as a whole path segment (between `/` and the next `/`, `?` or the end); it is refused in the host, in the query, as part of a segment, and twice. It must also survive URL normalisation: a later literal or percent-encoded dot-dot segment (`/{{in_reply_to}}/../done`) would drop the id from the path the sender receives, so it is refused. The check expands the placeholder to a stand-in segment made of id characters, extended until the submitted text does not contain it (so no existing segment can be mistaken for it), parses the result, and requires exactly one segment equal to the stand-in in the normalised path; zero and more than one both give the placement message. Any other `{{` or `}}` outside that one placeholder (an unknown name, wrong case, inner spaces, a lone pair) is refused; single braces are literal text and stay accepted. The two refusal messages are `Reply URL may contain {{in_reply_to}} only once, as a whole path segment` and `Reply URL contains an unknown placeholder`; neither echoes the input. A stored row is not rewritten or re-validated: a URL stored before this rule that contains `{{` or `}}` that is not the placeholder is refused on its next save, and at send time the server replaces every occurrence of the exact placeholder in the stored text and does nothing else. The stored value and every REST response keep the placeholder unexpanded.
- The reply URL is returned by list, get and patch as `replyUrl: string | null`. It is configuration, not a secret, but it may carry a token in its query: it is never written to a log, never returned by the MCP tool, and never placed in a notification or a delivery file.

**R2. MCP tool `reply_to_inbound_webhook`.** Parameters: `deliveryId: string`; `body: object` (a JSON object; arrays, strings, numbers, booleans and null are refused; agent-console does not interpret it); `replyId?: string` (present only when resending a reply already attempted, R4); `sessionId?: string` (the caller's session, same convention as `send_session_message`, resolved through `resolveSelfIdentity`; the tool is listed in `mcp/session-claiming-tools.ts`). The agent gets the delivery id from a notification field `delivery_id` on `external:message` (R7).

**R3. Ownership of `deliveryId`.** A session may reply to a delivery exactly when all hold: (1) `deliveryId` parses with `parseInboundWebhookDeliveryId`, which sits beside `inboundWebhookDeliveryId` (the single writer of the format): prefix `inbound-webhook:`, the endpoint id up to the next `:`, the rest as the webhook id (which may contain `:`) and the webhook id passes `isValidWebhookId`; (2) a row exists in `inbound_webhook_deliveries` for `(endpoint_id, webhook_id)` (rows cascade with the endpoint, so a deleted endpoint fails here); (3) a row exists in `inbound_event_notifications` with `job_id = deliveryId`, `session_id = <caller's session>` and `event_type = 'external:message'`, in any status (the row exists only for a target that routing resolved, so it is the routing record; requiring `delivered` would refuse a legitimate reply when the terminal-status write failed after the notification was sent). Failing any of the three returns one generic error, `Unknown delivery`, so the tool does not reveal which deliveries or endpoints exist.

**R4. Reply identity, retry and idempotency.**

- The message id is server-minted and server-recorded: `reply_<uuid v4>` (it matches `WEBHOOK_ID_PATTERN`). The caller never chooses it.
- Table `inbound_webhook_replies` holds one row per reply, committed before the first POST, so the id survives a crash or a timeout and the tool can always return it.
- First attempt: no `replyId`; the server mints the id, inserts the row, POSTs and returns the id with the outcome. Resend: the caller passes the `replyId` it was given; the server reuses the id (the `webhook-id` header is identical) with a new timestamp and a new signature. When to resend is the agent's decision under the sender's conventions; the server never retries on its own.
- A resend must carry the same body. The row stores `body_sha256`, the SHA-256 (hex) of the body's canonical JSON (object keys sorted recursively, `JSON.stringify` otherwise). A different hash is refused with `Body differs from the recorded reply; send a new reply instead`. The body itself is not stored. The bytes sent are `JSON.stringify(body)` of the body as given on that call, and they are what is signed.
- Bounds (exactly the bound is allowed, one more is refused): at most 10 attempts per reply id; at most 20 replies per (delivery, session).
- A `replyId` that does not exist, or belongs to another delivery or session, is the one generic error `Unknown reply`.
- Two concurrent calls with the same `replyId` both POST; the sender dedupes by id. `attempt_count` is incremented with a single `UPDATE ... SET attempt_count = attempt_count + 1 ... WHERE id = ? AND attempt_count < 10`, and the POST proceeds only if a row was updated.
- Fan-out: a delivery reaches every designated session and each may reply, with different reply ids. Which session answers is the operator's instruction text, not a server rule.

**R5. Signing and the request.**

- One exported `signStandardWebhook({ secret, id, timestamp, body }): string` returns `v1,<base64>`; `verifyStandardWebhookSignature` computes its expected value through the same inner computation (one writer of the HMAC input string and key decoding). Signing always uses the current `secret`, never `previous_secret`.
- Request: `POST <reply_url>` with headers `content-type: application/json`, `webhook-id: <replyId>`, `webhook-timestamp: <unix seconds>`, `webhook-signature: <v1,...>` and no header that carries server or session information. `redirect: 'manual'`: a 3xx is returned to the agent as its status and never followed. It goes through `outboundFetch`, injectable for tests.
- The secret and the reply URL are read at call time, so a rotation or an edit between attempts takes effect on the next attempt.
- **Expansion.** After the endpoint is read and before the request is signed and sent, `expandReplyUrl(storedUrl, webhookId)` replaces every occurrence of the placeholder with `encodeURIComponent(webhookId)`; with no placeholder the URL called is the stored text byte for byte. The value is the original `webhook-id` of the delivery the server authorised in R3 (the same variable the ownership queries use), never taken from the body or a tool argument, so the agent cannot change which message is addressed. The id grammar is `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, so only `:` changes (to `%3A`) and the result is one path segment that can never be `.` or `..`. Expansion happens on every attempt from the URL as stored at that moment, so a resend with the same reply id produces the same URL unless the operator edited it. The URL called is the expanded one: the request goes to it and the response redaction (table row 13) is built from it. A sender's router must decode the segment before comparing.
- Reflection guard: the receive half treats a `webhook-id` that equals an id in `inbound_webhook_replies` for that endpoint as a duplicate (200, no job, a warn log with ids only). A reply is a validly signed message under the receive secret; without the guard, a message echoed back by the sender would be delivered to the sessions as a new inbound message.

**R6. Bounds, timeout, response handling.** The request body is at most 262,144 UTF-8 bytes (exactly the cap is accepted). One timeout covers the whole exchange: `INBOUND_WEBHOOK_REPLY_TIMEOUT_MS`, default 10,000, in `server-config.ts`. The response body is read as a stream, at most 4,096 UTF-8 bytes are kept (the reader is cancelled at the cap), returned as text through `sanitizeMultiline`, cut at a code-point boundary, with `responseBodyTruncated`; it is untrusted sender text. The `retry-after` response header is returned as `retryAfter` (through `toSingleLine`, at most 64 characters); no other response header is returned. Result shapes: `{ replyId, attempt, outcome: 'responded', status, responseBody, responseBodyTruncated, retryAfter? }` for any HTTP status, and `{ replyId, attempt, outcome: 'no-response', reason }` with `reason` one of `timeout` | `connection-failed`. Never returned: the signature, the secret, the reply URL or its host, any request header.

**R7. Notification field `delivery_id`.** `external:message` notifications gain the field `delivery_id` (the delivery id string), rendered immediately after `body_path` and before the attachment counts, live and deferred alike. It is added to the server-only `InboundEventPtyNotification['fields']`; no shared schema changes.

**R8. Logging and data at rest.** One `info` record per attempt: `endpointId`, `deliveryId`, `replyId`, `sessionId`, `attempt`, `outcome`, `status` or `reason`, `durationMs`, `requestBytes`, `responseBytes`. Never logged: the request body, the response body, the secret, the signature, the reply URL (not even its host), and the text of a thrown fetch error (only `errorName`, because a fetch error message can carry the URL). Refusals are logged at `warn` with ids and a reason code only. Data at rest added: `reply_url` (configuration) and `inbound_webhook_replies` rows (ids, a body hash, counters, timestamps; no body). Rows cascade with their delivery row and so with the endpoint, and, like the deliveries ledger, are not pruned. The endpoint management routes added in the first step also never log the reply URL. The agent-facing rule is the requirement: the reply URL, in either form (the stored template or the expanded URL), never reaches a tool result, a notification or a delivery file. That the server does not log it is current behaviour, not a requirement (decided 2026-11-22: sending needs the shared secret, so the URL alone grants nothing). The placeholder adds no logging of either form.

**R9. Wire schema.** `InboundWebhookEndpointSchema` gains `replyUrl: string | null` and the create and update request schemas gain it, which moves the wire-schema hash. The receive route's contract is unchanged except the reflection guard (a 200 that was already the duplicate answer).

**R10. Two steps, serial.** Step 1: migration v57 (column and table in one migration), repository, shared schema, REST, UI, this section, glossary. Step 2 (no DDL, no wire schema): signing helper, reply service, MCP tool, notification field, reflection guard, smoke.

**R11. Verification tier.** Unprivileged: no elevation and no OS coupling; the server makes one HTTPS call as itself.

Verification of the reply path, as shipped (recorded proxy):

- A local TLS stub with a certificate generated at run time cannot be set up on agent hosts (certificate generation is refused there), so no verification in this step completes a TLS exchange with a sender.
- The smoke (`scripts/smoke/check-inbound-webhook-routing.ts`) opens a plain TCP listener on 127.0.0.1 and gives an endpoint `https://127.0.0.1:<port>/replies?token=<marker>` as its reply URL. The server's real outbound call connects, the handshake fails, and the tool returns `outcome: 'no-response'`, `reason: 'connection-failed'` (table row 16). The listener counts connections, so a request made and a request not made are both observed on the wire. It cannot see headers or the signature. Arms: an outbound attempt (the control for the next two), a resend with the same reply id, nothing secret in any result or captured output, a session that was not a target of the delivery (no connection), and an endpoint without a reply URL (no connection). A further arm gives an endpoint a reply URL whose last path segment is the placeholder with the query marker after it: the reply returns `connection-failed` with exactly one new connection (the real outbound call accepted the expanded URL) and the placeholder literal is absent from every tool result. The listener cannot see the request path, so the expanded path itself is not observed by the smoke and no polarity is claimed for that arm; it is pinned in process by the reply service tests.
- The success path runs in process with a real database, the real endpoint repository, the real reply service and the real MCP handler; only `fetch` is injected, at the service's dependency seam. The injected fetch plays the sender and verifies the signature with its own HMAC code written from the scheme's specification, using the secret captured from the repository's create. What is substituted is the transport only; it is outside the chain this step changes (`outboundFetch` is unchanged and is reached for real by the smoke's outbound arm), and the database, repository, service, MCP handler and signing stay real.
- Covered only with the injected fetch: response handling (rows 12-14 and 17), the timeout (row 15) and `redirect: 'manual'` against a real 3xx.
- A completed signed exchange over TLS is first exercised by the first production reply; the operator confirms the tool result shows a 2xx status from the sender.

#### Reply tool behaviour (order of evaluation)

| # | Case | Result |
|---|---|---|
| 1 | caller identity not resolved (`resolveSelfIdentity` fails) | its error, unchanged |
| 2 | `body` not an object (array, string, number, boolean, null, missing) | error `body must be a JSON object` |
| 3 | serialized body over 262,144 bytes | error `body is too large` (exactly the cap passes) |
| 4 | `deliveryId` malformed / no delivery row / endpoint deleted / not routed to the caller's session | error `Unknown delivery` (one message for all four) |
| 5 | endpoint has no reply URL | error `Replies are not enabled for this endpoint` |
| 6 | no `replyId`, and the (delivery, session) already has 20 replies | error `Reply limit reached for this delivery` |
| 7 | no `replyId`, under the limit | mint id, insert row, attempt 1 |
| 8 | `replyId` unknown, or of another delivery, or of another session | error `Unknown reply` |
| 9 | `replyId` known, body hash differs | error `Body differs from the recorded reply; send a new reply instead` |
| 10 | `replyId` known, 10 attempts already made | error `Attempt limit reached for this reply` |
| 11 | `replyId` known, same body, under the limit | attempt n+1, same id, new timestamp and signature |
| 12 | sender answers any status (2xx, 3xx, 4xx, 5xx) | `outcome: 'responded'` with the status; 3xx not followed |
| 13 | response body over 4,096 bytes | first 4,096 bytes at a code-point boundary, `responseBodyTruncated: true`. Values the sender could echo back are replaced with `[redacted]` in the decoded text and in `retryAfter`, before the control-character cleanup, longest match first: the full signature header value and its base64 part; the reply URL as called (the expanded one, which is what the sender received; the bare id echoed alone is not a needle and is returned); `pathname + search` and `search` of the parsed URL (only when `search` is non-empty); each query value of 8 or more characters, raw and percent-decoded. Shorter query values are not redacted. Known residue: a value cut by the 4,096-byte cap can leave a prefix, because redaction runs on what was kept. The reader is cancelled at the cap, awaited only until the exchange deadline, and a failed cancel never changes the result |
| 14 | response body empty | `responseBody: ''`, `responseBodyTruncated: false` |
| 15 | timeout before headers | `outcome: 'no-response'`, `reason: 'timeout'` |
| 16 | connection / TLS failure | `outcome: 'no-response'`, `reason: 'connection-failed'` |
| 17 | headers received, body read times out | `outcome: 'responded'`, partial body, `responseBodyTruncated: true` |
| 18 | secret rotated or reply URL changed since the first attempt | the current values are used |
| 19 | reply URL cleared since the first attempt | row 5 |
| 20 | database write of the reply row fails | tool error, nothing sent |
| 21 | recording the attempt's outcome (`last_status`) fails after the POST | the result is still returned; warn log. Only the latest attempt records its status: the update is conditioned on `attempt_count` still being this attempt's number, and an attempt that is no longer the latest updates no row (neither an error nor a warning) |
| 22 | single-user and multi-user modes | identical (no elevation, no per-user state) |
| 23 | database error during the ownership check | tool error, nothing sent, no reply row (not `Unknown delivery`, which is a permission answer the agent would act on) |
| 24 | delivery row exists but the endpoint is gone | `Unknown delivery` |
| 25 | `retry-after` empty or whitespace-only after cleanup | no `retryAfter` key (`'120'` is returned as `'120'`) |
| 26 | the attempt counter write | a new reply's row is inserted already counted as attempt 1; a resend's attempt is counted by one guarded UPDATE; both happen before the POST, so the attempt is already counted when the request is made. A failure of either is row 20's text and nothing is sent (any write after the POST is row 21); a failed new-reply insert leaves no row and returns no `replyId` |
| 27 | the two caps under concurrent calls | both atomic: one `INSERT ... SELECT` with the count in its `WHERE` (zero rows inserted is row 6) and one guarded `UPDATE` (zero rows updated is row 10) |

#### Reply URL validation (boundary values)

| Input | Result |
|---|---|
| omitted on create / update | create: stored NULL; update: unchanged |
| `null` on update | cleared |
| `null` on create | 400 (create takes a string or nothing) |
| `''` | 400 |
| 2,048 characters, otherwise valid | accepted; 2,049 -> 400 |
| `http://...` | 400 |
| `https://user:pass@host/` | 400 |
| `https://host/path#frag` | 400 |
| `https://host/path?token=abc` | accepted |
| `https://localhost:8443/x`, `https://10.0.0.5/x` | accepted |
| not a URL | 400 |
| leading or trailing whitespace, any control character (`\p{Cc}`: C0, DEL and C1) | 400 |
| a `#` anywhere, including an empty fragment (`https://host/p#`, `https://host/p?a=1#`) | 400 |
| a form that URL parsing reads as a host the text does not show (`https:///x`, `https:x`, `https:/x`, `https:\\host\p`); the text must start with `https://` and a host character | 400 |
| `HTTPS://host/p` (scheme case), a space in the path, `%23` in a query, a bare `https://host` | accepted |
| update body with none of `label`, `instructionText`, `replyUrl` | 400 (the existing "at least one" rule, extended) |
| `https://host/reply/{{in_reply_to}}`, `https://host/a/{{in_reply_to}}/b`, `https://host/r/{{in_reply_to}}?t=abc` | accepted |
| `https://host/{{in_reply_to}}/{{in_reply_to}}` | 400 (once) |
| `https://host/r?x={{in_reply_to}}` | 400 (query) |
| `https://{{in_reply_to}}.host/x` | 400 (host; URL parsing alone accepts it, the placement check refuses it) |
| `https://host/r-{{in_reply_to}}`, `https://host/{{in_reply_to}}x` | 400 (not a whole segment) |
| `https://host/reply/{{in_reply_to}}/../done`, `https://host/reply/{{in_reply_to}}/%2e%2e/done`, `https://host/reply/{{in_reply_to}}/.%2E`, `https://host/Ab0/{{in_reply_to}}/..`, `https://host/{{in_reply_to}}/../Ab0` | 400 (cancelled by a later dot-dot segment; the placement message) |
| `https://host/./{{in_reply_to}}/./b`, `https://host/a/../{{in_reply_to}}`, `https://host/Ab0/{{in_reply_to}}` | accepted (the id survives normalisation) |
| `{{delivery_id}}`, `{{IN_REPLY_TO}}`, `{{ in_reply_to }}`, a lone `{{` or `}}` | 400 (unknown placeholder) |
| `https://host/r/{in_reply_to}` | accepted, literal, not expanded |
| 2,048 characters including the placeholder | accepted; 2,049 -> 400 |

#### DDL (migration v57, owner-approved 2026-11-20)

```sql
ALTER TABLE inbound_webhook_endpoints
  ADD COLUMN reply_url TEXT
  CONSTRAINT iwe_reply_url_length_check CHECK (reply_url IS NULL OR length(reply_url) BETWEEN 1 AND 2048);

CREATE TABLE IF NOT EXISTS inbound_webhook_replies (
  id               TEXT PRIMARY KEY,
  endpoint_id      TEXT NOT NULL,
  webhook_id       TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  body_sha256      TEXT NOT NULL,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_status      INTEGER,
  created_at       TEXT NOT NULL,
  last_attempt_at  TEXT,
  FOREIGN KEY (endpoint_id, webhook_id)
    REFERENCES inbound_webhook_deliveries(endpoint_id, webhook_id) ON DELETE CASCADE,
  CONSTRAINT iwr_body_sha256_length_check CHECK (length(body_sha256) = 64),
  CONSTRAINT iwr_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT iwr_created_at_check CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  CONSTRAINT iwr_last_attempt_at_check CHECK (last_attempt_at IS NULL OR last_attempt_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
);
CREATE INDEX IF NOT EXISTS idx_iwr_delivery_session
  ON inbound_webhook_replies (endpoint_id, webhook_id, session_id);

PRAGMA user_version = 57;
```

Existing endpoint rows get `reply_url = NULL`, so replies stay refused until an operator sets a URL and no existing behaviour changes. `session_id` has no foreign key on purpose: a reply row outlives its session (like the deliveries ledger) and goes away with the endpoint. `last_status` is the HTTP status of the latest attempt, NULL when there was no response. The GLOB literals are what `ISO8601_GLOB_PATTERN` renders; the migration emits them from the constant.

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
