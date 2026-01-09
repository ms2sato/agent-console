# Inbound Integration Design

This document describes the design for receiving external events into Agent Console and notifying Claude Code instances.

## Overview

Inbound integration allows external systems to send events to Agent Console, which then notifies the appropriate Claude Code instance via PTY write.

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
        │ 4. Write to PTY
        ▼
Claude Code receives notification
```

## Base Architecture

### Components

| Component | Responsibility |
|-----------|----------------|
| Webhook Router | Route requests to service-specific handlers, authenticate, enqueue |
| Notification Queue | Store pending notifications for async processing |
| Queue Processor | Process queued items: parse, resolve, notify |
| Service Handler | Parse service-specific payloads and resolve to sessions |
| PTY Notifier | Write formatted message to Agent Worker's PTY |

### Design Principles

1. **Always return 200 OK** - Webhook providers (GitHub, etc.) may disable webhooks or retry on errors
2. **Async processing via queue** - Authenticate and enqueue immediately, process asynchronously
3. **Resolve early** - Convert external identifiers (URL, branch) to internal IDs (repositoryId, sessionId) in Service Handler

### Flow

```typescript
// Pseudocode for inbound integration flow

// Step 1: Receive webhook (synchronous, fast)
app.post('/webhooks/:service', async (c) => {
  const service = c.req.param('service');
  const handler = getServiceHandler(service);

  // Authenticate (service-specific)
  const payload = await c.req.text();
  if (!await handler.authenticate(payload, c.req.raw.headers)) {
    // Authentication failure - log and discard (do NOT return error)
    // Returning 4xx/5xx causes webhook providers to retry
    logger.warn({ service }, 'Webhook authentication failed');
    return c.json({ ok: true });
  }

  // Enqueue for async processing using existing JobQueue
  const jobId = generateId();
  jobQueue.enqueue('webhook:process', {
    jobId,
    service,
    rawPayload: payload,
    headers: Object.fromEntries(c.req.raw.headers),
    receivedAt: new Date().toISOString(),
  } satisfies WebhookJobPayload);

  // Always return OK
  return c.json({ ok: true });
});

// Step 2: Process queue (asynchronous)
// JobQueue calls this handler when processing 'webhook:process' jobs
jobQueue.registerHandler('webhook:process', async (payload: WebhookJobPayload) => {
  const { jobId, service, rawPayload, headers } = payload;
  const handler = getServiceHandler(service);

  // Parse and resolve to notification
  const notification = await handler.parseAndResolve(rawPayload, headers);

  if (!notification) {
    // No matching sessions - job completes successfully (not an error)
    return;
  }

  // Notify all matched sessions and record each notification
  for (const target of notification.targets) {
    ptyNotifier.notify(target.sessionId, target.workerId, notification.message);

    // Record notification for Worker history
    await inboundEventNotificationRepository.create({
      id: generateId(),
      jobId,
      sessionId: target.sessionId,
      workerId: target.workerId ?? 'all',
      message: notification.message,
      notifiedAt: new Date().toISOString(),
    });
  }
});
```

### Database Schema

Webhook processing uses the existing JobQueue for persistence and adds a notification history table.

#### Job Payload (stored in `jobs.payload`)

```typescript
interface WebhookJobPayload {
  jobId: string;                // Same as jobs.id (for cross-reference)
  service: string;              // 'github', 'gitlab', etc.
  rawPayload: string;           // Raw JSON payload
  headers: Record<string, string>;
  receivedAt: string;           // ISO timestamp
}
```

The `jobs` table (from [Local Job Queue](./local-job-queue-design.md)) stores:
- Webhook payload (service, raw data, headers)
- Processing status (pending, processing, completed, stalled)
- Retry information (attempts, last_error)
- Timestamps (created_at, completed_at)

#### Notification History Table (new)

```typescript
interface InboundEventNotification {
  id: string;
  jobId: string;          // Reference to jobs.id
  sessionId: string;
  workerId: string;       // 'all' if notified all Agent Workers
  message: string;        // The message sent to PTY
  notifiedAt: string;     // ISO timestamp
}
```

SQLite table:

```sql
CREATE TABLE inbound_event_notifications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  message TEXT NOT NULL,
  notified_at TEXT NOT NULL
);

CREATE INDEX idx_inbound_event_notifications_job ON inbound_event_notifications(job_id);
CREATE INDEX idx_inbound_event_notifications_session_worker ON inbound_event_notifications(session_id, worker_id);
```

#### Querying Worker's Event History

```sql
-- Get events received by a specific Worker
SELECT
  ien.notified_at,
  ien.message,
  j.type,
  j.payload,
  j.status,
  j.created_at
FROM inbound_event_notifications ien
JOIN jobs j ON ien.job_id = j.id
WHERE ien.session_id = ? AND ien.worker_id = ?
ORDER BY ien.notified_at DESC
LIMIT 50;
```

Benefits:
- **Reuse existing infrastructure**: JobQueue handles persistence, retry, recovery
- **Worker history**: Track which events each Worker received
- **Debugging**: Full payload available in jobs table for replay

### Service Handler Interface

```typescript
interface InboundServiceHandler {
  /** Service identifier (e.g., 'github', 'gitlab') */
  readonly serviceId: string;

  /** Authenticate the incoming request (fast, synchronous check) */
  authenticate(payload: string, headers: Headers): Promise<boolean>;

  /**
   * Parse payload and resolve to notification targets.
   * Returns null if no matching sessions found (not an error).
   */
  parseAndResolve(
    payload: string,
    headers: Record<string, string>
  ): Promise<InboundNotification | null>;
}

interface InboundNotification {
  /** Resolved notification targets */
  targets: NotificationTarget[];

  /** Formatted message for Claude Code */
  message: string;

  /** Metadata for logging */
  metadata: {
    eventType: string;       // e.g., 'workflow_run'
    repositoryName: string;  // e.g., 'owner/repo'
    branch: string;
  };
}

interface NotificationTarget {
  sessionId: string;
  workerId?: string;  // If undefined, notify all Agent Workers in session
}
```

### Session Resolution (inside Service Handler)

Service Handler is responsible for resolving external identifiers to internal session IDs:

```typescript
// Inside GitHubHandler.parseAndResolve()
async parseAndResolve(
  payload: string,
  headers: Record<string, string>
): Promise<InboundNotification | null> {
  const body = JSON.parse(payload);
  const eventType = headers['x-github-event'];

  if (eventType !== 'workflow_run') {
    return null; // Unsupported event type
  }

  // Extract external identifiers
  const cloneUrl = body.repository.clone_url;
  const branch = body.workflow_run.head_branch;

  // Resolve to internal IDs
  const sessions = await this.resolveToSessions(cloneUrl, branch);
  if (sessions.length === 0) {
    return null; // No matching sessions
  }

  // Build notification
  return {
    targets: sessions.map(s => ({ sessionId: s.id })),
    message: this.formatMessage(body),
    metadata: {
      eventType: 'workflow_run',
      repositoryName: body.repository.full_name,
      branch,
    },
  };
}

private async resolveToSessions(cloneUrl: string, branch: string): Promise<Session[]> {
  // Normalize URL
  const normalizedUrl = normalizeGitUrl(cloneUrl);

  // Find repository by remoteUrl
  const repository = await this.repositoryStore.findByRemoteUrl(normalizedUrl);
  if (!repository) return [];

  // Find sessions by repositoryId and branch
  return this.sessionStore.findByRepositoryAndBranch(repository.id, branch);
}
```

### Repository Matching

Use existing `parseOrgRepo` function from `packages/server/src/lib/git.ts` to extract `owner/repo` from URLs:

```typescript
// Existing function in lib/git.ts
parseOrgRepo('git@github.com:owner/repo.git')           // 'owner/repo'
parseOrgRepo('https://github.com/owner/repo.git')       // 'owner/repo'
parseOrgRepo('https://github.com/owner/repo')           // 'owner/repo'
```

For matching, compare extracted `owner/repo` strings rather than normalizing full URLs:

```typescript
function matchRepository(webhookCloneUrl: string, dbRemoteUrl: string): boolean {
  const webhookOrgRepo = parseOrgRepo(webhookCloneUrl);
  const dbOrgRepo = parseOrgRepo(dbRemoteUrl);

  if (!webhookOrgRepo || !dbOrgRepo) return false;

  return webhookOrgRepo.toLowerCase() === dbOrgRepo.toLowerCase();
}
```

### PTY Notification

```typescript
class PtyNotifier {
  notify(session: Session, message: string): void {
    // Find agent workers in the session
    const agentWorkers = this.sessionManager.getAgentWorkers(session.id);

    for (const worker of agentWorkers) {
      // Write to PTY stdin
      worker.pty.write(message);
    }
  }
}
```

#### Message Format Guidelines

- Start with newline to separate from current output
- Use a clear prefix (e.g., `[GitHub CI]`, `[GitLab Pipeline]`)
- Keep messages concise but informative
- Include URL for details when available

```
\n[Service Name] Status indicator and summary
Key details on separate lines
URL: https://...
```

## GitHub Implementation

### Endpoint

```
POST /webhooks/github
```

### Authentication

GitHub signs webhooks with HMAC-SHA256 using a shared secret.

```typescript
class GitHubHandler implements InboundServiceHandler {
  readonly serviceId = 'github';

  constructor(
    private webhookSecret: string,
    private repositoryStore: RepositoryStore,
    private sessionStore: SessionStore
  ) {}

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

### Parse and Resolve

Handle `workflow_run` event (CI completion) and resolve to sessions:

```typescript
async parseAndResolve(
  payload: string,
  headers: Record<string, string>
): Promise<InboundNotification | null> {
  const body = JSON.parse(payload);
  const eventType = headers['x-github-event'];

  // Only handle workflow_run completed events
  if (eventType !== 'workflow_run' || body.action !== 'completed') {
    return null;
  }

  const cloneUrl = body.repository.clone_url;
  const branch = body.workflow_run.head_branch;
  const repositoryName = body.repository.full_name;

  // Resolve to sessions
  const sessions = await this.resolveToSessions(cloneUrl, branch);
  if (sessions.length === 0) {
    return null;
  }

  // Format message
  const message = this.formatMessage(body);

  return {
    targets: sessions.map(s => ({ sessionId: s.id })),
    message,
    metadata: {
      eventType: 'workflow_run',
      repositoryName,
      branch,
    },
  };
}

private async resolveToSessions(cloneUrl: string, branch: string): Promise<Session[]> {
  const normalizedUrl = normalizeGitUrl(cloneUrl);
  const repository = await this.repositoryStore.findByRemoteUrl(normalizedUrl);
  if (!repository) return [];

  return this.sessionStore.findByRepositoryAndBranch(repository.id, branch);
}

private formatMessage(body: GitHubWorkflowRunPayload): string {
  const { conclusion, name: workflowName, html_url: htmlUrl } = body.workflow_run;
  const repositoryName = body.repository.full_name;
  const branch = body.workflow_run.head_branch;

  const statusIcon = conclusion === 'success' ? 'SUCCESS' :
                     conclusion === 'failure' ? 'FAILURE' :
                     conclusion.toUpperCase();

  return `\n[GitHub CI] ${statusIcon}: "${workflowName}"\n` +
         `Repository: ${repositoryName}\n` +
         `Branch: ${branch}\n` +
         `URL: ${htmlUrl}\n`;
}
```

### GitHub Webhook Setup

1. Go to repository Settings → Webhooks → Add webhook
2. Payload URL: `https://<your-domain>/webhooks/github`
3. Content type: `application/json`
4. Secret: Generate and save in Agent Console settings
5. Events: Select "Workflow runs" (or specific events needed)

## Configuration

### Settings Schema

```typescript
interface InboundIntegrationSettings {
  github?: {
    webhookSecret: string;
    enabled: boolean;
  };
  // Future services
  gitlab?: {
    webhookToken: string;
    enabled: boolean;
  };
}
```

### Environment Variables

```bash
# GitHub webhook secret
GITHUB_WEBHOOK_SECRET=your-secret-here
```

## Future Extensions

### Adding New Services

1. Implement `InboundServiceHandler` interface
2. Register handler in webhook router
3. Add service-specific configuration
4. Document webhook setup for the service

### Example: GitLab

```typescript
class GitLabHandler implements InboundServiceHandler {
  readonly serviceId = 'gitlab';

  async authenticate(req: Request): Promise<boolean> {
    const token = req.headers.get('X-Gitlab-Token');
    return token === await this.getWebhookToken();
  }

  async parsePayload(req: Request): Promise<InboundEvent> {
    const body = await req.json();
    // Parse GitLab pipeline event
    return {
      type: 'pipeline',
      repository: {
        url: body.project.git_http_url,
        fullName: body.project.path_with_namespace,
      },
      branch: body.object_attributes.ref,
      payload: { /* ... */ },
    };
  }
}
```

### Custom Webhook (Future)

For services without specific handlers, a generic webhook endpoint:

```
POST /webhooks/custom
```

With user-configurable:
- Authentication method (header token, query param, etc.)
- Payload mapping (JSONPath to extract repository, branch, message)
- Message template

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

**Important**: No error responses are returned, even for:
- Authentication failure
- Invalid payload format
- No matching sessions

This prevents webhook providers (GitHub, etc.) from:
- Retrying failed requests repeatedly
- Disabling the webhook endpoint after too many failures

All failures are logged server-side for debugging.

## Related Documents

- [Outbound Integration](./integration-outbound.md) - Sending notifications to external systems
- [Session & Worker Design](./session-worker-design.md) - Session/Worker architecture
