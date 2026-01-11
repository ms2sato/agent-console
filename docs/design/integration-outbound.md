# Outbound Integration Design

This document describes the design for sending notifications from Agent Console to external systems when Claude Code's state changes.

> **Prerequisite**: See [System Events](./system-events.md) for event format and type definitions.

## Outbound Event Types

Outbound events are internal events that trigger notifications to external services.

```typescript
/** Event types that can trigger outbound notifications */
type OutboundTriggerEventType =
  | 'agent:waiting'   // Agent is asking a question
  | 'agent:idle'      // Agent finished processing
  | 'agent:active'    // Agent is actively processing
  | 'worker:error'    // Worker encountered an error
  | 'worker:exited';  // Worker process exited

/**
 * Internal event format for outbound notifications.
 * Each event type has specific payload for UI presentation.
 */
type NotificationEvent =
  | { type: 'agent:waiting'; activityState: 'waiting'; timestamp: string }
  | { type: 'agent:idle'; activityState: 'idle'; timestamp: string }
  | { type: 'agent:active'; activityState: 'active'; timestamp: string }
  | { type: 'worker:error'; message: string; timestamp: string }
  | { type: 'worker:exited'; exitCode: number; timestamp: string };
// Note: timestamp is ISO 8601 string for consistency with SystemEvent

// Bidirectional type assertions:
// 1. NotificationEvent types must be valid OutboundTriggerEventType
type _AssertValidTypes = NotificationEvent['type'] extends OutboundTriggerEventType
  ? true
  : never;

// 2. All OutboundTriggerEventType must have corresponding NotificationEvent
type _AssertComplete = OutboundTriggerEventType extends NotificationEvent['type']
  ? true
  : never;  // Compile error if any OutboundTriggerEventType is missing from NotificationEvent
```

> **Note**: `SystemEventType` in [System Events](./system-events.md) is the union of `InboundEventType` and `OutboundTriggerEventType`.

## Overview

Outbound integration allows Agent Console to notify users through external systems (e.g., Slack) when Claude Code requires attention.

```
Claude Code (state changes)
        │
        │ PTY output parsed
        ▼
ActivityDetector
        │
        │ Activity state change detected
        ▼
Agent Console Server
        │
        │ 1. Check notification rules
        │ 2. Format message (service-specific)
        │ 3. Send notification
        ▼
External System (e.g., Slack)
        │
        │ User sees notification
        ▼
User clicks URL to access Agent Console
```

## Base Architecture

### Components

| Component | Responsibility |
|-----------|----------------|
| Notification Trigger | Detect events that should trigger notifications |
| Notification Router | Route events to configured service handlers |
| Service Handler | Format and send notifications to specific services |
| Configuration Store | Manage notification settings per session/global |

### Trigger Events

Outbound notifications are triggered by internal events (defined in [System Events](./system-events.md)):

| Event Type | Description | Default Notify |
|------------|-------------|----------------|
| `agent:waiting` | Claude is asking a question | Yes |
| `agent:idle` | Claude finished processing | Yes |
| `agent:active` | Claude started processing | No |
| `worker:error` | Worker encountered an error | Yes |
| `worker:exited` | Worker process exited | Optional |

### Event Trigger Sources

Each event type has a different trigger source:

| Event Type | Trigger Source | Entry Point |
|------------|----------------|-------------|
| `agent:waiting` | ActivityDetector | `onActivityChange()` |
| `agent:idle` | ActivityDetector | `onActivityChange()` |
| `agent:active` | ActivityDetector | `onActivityChange()` |
| `worker:error` | PTY error event | `onWorkerError()` |
| `worker:exited` | PTY exit event | `onWorkerExit()` |

### Flow

```typescript
// Pseudocode for outbound notification flow
class NotificationManager {
  /**
   * Called when agent activity state changes (waiting/idle/active).
   * Triggered by ActivityDetector parsing PTY output.
   */
  onActivityChange(
    session: Session,
    worker: Worker,
    newState: AgentActivityState
  ): void {
    const event: NotificationEvent = {
      type: this.mapActivityToEventType(newState),
      activityState: newState,
      timestamp: new Date().toISOString(),
    };
    this.sendNotification(session, worker, event);
  }

  /**
   * Called when worker encounters an error.
   * Triggered by PTY error event.
   */
  onWorkerError(session: Session, worker: Worker, message: string): void {
    const event: NotificationEvent = {
      type: 'worker:error',
      message,
      timestamp: new Date().toISOString(),
    };
    this.sendNotification(session, worker, event);
  }

  /**
   * Called when worker process exits.
   * Triggered by PTY exit event.
   */
  onWorkerExit(session: Session, worker: Worker, exitCode: number): void {
    const event: NotificationEvent = {
      type: 'worker:exited',
      exitCode,
      timestamp: new Date().toISOString(),
    };
    this.sendNotification(session, worker, event);
  }

  private sendNotification(
    session: Session,
    worker: Worker,
    event: NotificationEvent
  ): void {
    // Check if notification should be sent
    const config = this.getNotificationConfig(session.id);
    if (!config.rules.triggers[event.type]) return;

    // Build notification context
    const context: NotificationContext = {
      session,
      worker,
      event,
      agentConsoleUrl: this.buildSessionUrl(session, worker),
    };

    // Send to all configured services
    for (const handler of this.getEnabledHandlers(config)) {
      handler.send(context).catch(err => {
        this.logger.error(`Notification failed: ${handler.serviceId}`, err);
      });
    }
  }

  private mapActivityToEventType(state: AgentActivityState): OutboundTriggerEventType {
    switch (state) {
      case 'waiting': return 'agent:waiting';
      case 'idle': return 'agent:idle';
      case 'active': return 'agent:active';
      default: return 'agent:active';
    }
  }
}
```

### Service Handler Interface

Outbound handlers receive `NotificationContext` (which includes the triggering event) and send formatted notifications to external services.

> **Note**: Outbound integration uses `NotificationEvent` internally rather than `SystemEvent`. This is because outbound notifications are tightly coupled to UI presentation and require different data structures (e.g., `activityState` for status display).

```typescript
interface OutboundServiceHandler {
  /** Service identifier (e.g., 'slack', 'discord') */
  readonly serviceId: string;

  /** Send notification to the service */
  send(context: NotificationContext): Promise<void>;

  /** Validate service-specific configuration */
  validateConfig(config: unknown): boolean;
}

interface NotificationContext {
  session: Session;
  worker: Worker;
  event: NotificationEvent;  // Defined in "Outbound Event Types" section
  agentConsoleUrl: string;
}
```

### Notification Rules

```typescript
interface NotificationRules {
  /**
   * Events that trigger notifications.
   * Keys are OutboundTriggerEventType (derived from NotificationEvent).
   */
  triggers: Partial<Record<OutboundTriggerEventType, boolean>>;

  /**
   * Debounce settings.
   * Notifications are only sent when state changes AND persists for debounceSeconds.
   */
  debounce?: {
    /** Wait N seconds for state to stabilize before sending notification */
    debounceSeconds: number;
  };
}

// Default configuration
const defaultNotificationRules: NotificationRules = {
  triggers: {
    'agent:waiting': true,   // Claude is asking
    'agent:idle': true,      // Claude finished
    'agent:active': false,   // Claude started (usually not notified)
    'worker:error': true,    // Error occurred
    'worker:exited': false,  // Process exited (optional)
  },
  debounce: {
    debounceSeconds: 3,      // Wait 3s for state to stabilize
  },
};
```

> **Note**: Notifications are only sent when the state **changes**. The same state persisting does not trigger repeated notifications.

## Slack Implementation

### Configuration

```typescript
interface SlackConfig {
  webhookUrl: string;
  enabled: boolean;
}
```

> **Note**: Modern Slack App webhooks ignore `username` and `icon_emoji` in the payload.
> To customize the bot name and icon, configure them in your Slack App settings.

### Handler Implementation

```typescript
class SlackHandler implements OutboundServiceHandler {
  readonly serviceId = 'slack';

  async send(context: NotificationContext): Promise<void> {
    const config = await this.getConfig();
    if (!config.enabled) return;

    const message = this.buildMessage(context);

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }
  }

  private buildMessage(context: NotificationContext): SlackMessage {
    const { session, event, agentConsoleUrl } = context;
    const sessionName = session.title || session.worktreeId || 'Quick Session';

    let statusText: string;
    let statusEmoji: string;

    switch (event.type) {
      case 'agent:waiting':
        statusText = 'is asking a question';
        statusEmoji = ':question:';
        break;
      case 'agent:idle':
        statusText = 'has finished';
        statusEmoji = ':white_check_mark:';
        break;
      case 'agent:active':
        statusText = 'is processing';
        statusEmoji = ':hourglass:';
        break;
      case 'worker:error':
        statusText = 'encountered an error';
        statusEmoji = ':x:';
        break;
      case 'worker:exited':
        statusText = 'process exited';
        statusEmoji = ':stop_sign:';
        break;
    }

    return {
      text: `${statusEmoji} [${sessionName}] Claude ${statusText}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${statusEmoji} *${sessionName}*\nClaude ${statusText}`,
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open Session' },
            url: agentConsoleUrl,
            action_id: 'open_session',
          },
        },
      ],
    };
  }

  validateConfig(config: unknown): boolean {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;
    return (
      typeof c.webhookUrl === 'string' &&
      c.webhookUrl.startsWith('https://hooks.slack.com/')
    );
  }
}
```

### Slack Webhook Setup

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Create new app → From scratch
3. Add feature → Incoming Webhooks → Activate
4. Add New Webhook to Workspace → Select channel
5. Copy Webhook URL to Agent Console settings

## Configuration

### Global Settings

```typescript
interface OutboundIntegrationSettings {
  /** Base URL for Agent Console (for notification URLs) */
  baseUrl: string;

  /** Default notification rules */
  defaultRules: NotificationRules;
}
```

> **Note**: Service configurations (Slack, etc.) are managed at the **repository level**, not globally. See "Repository-level Slack Integration" below.

### Repository-level Slack Integration

Each repository can have its own Slack integration settings. This allows different repositories to notify different Slack channels.

#### Database Schema

```sql
CREATE TABLE repository_slack_integrations (
  id TEXT PRIMARY KEY,                                              -- UUID
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL,                                        -- Slack webhook URL
  enabled INTEGER NOT NULL DEFAULT 1,                               -- 0 = disabled, 1 = enabled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> **Note**: Modern Slack App webhooks ignore `username` and `icon_emoji` in the payload.
> These must be configured in the Slack App settings, not per-message.

#### TypeScript Interface

```typescript
interface RepositorySlackIntegration {
  id: string;
  repositoryId: string;
  webhookUrl: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

#### Webhook Resolution

Notifications are only sent if the session's repository has Slack integration configured and enabled.

```typescript
function getSlackWebhookUrl(session: Session): string | null {
  // Only repository-level integration is supported
  if (session.repositoryId) {
    const repoIntegration = getRepositorySlackIntegration(session.repositoryId);
    if (repoIntegration?.enabled) {
      return repoIntegration.webhookUrl;
    }
  }

  // No global fallback - repository integration required
  return null;
}
```

> **Note**: Sessions not associated with a repository (quick sessions) do not send Slack notifications.

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/repositories/:id/integrations/slack` | Get Slack integration for repository |
| PUT | `/api/repositories/:id/integrations/slack` | Create or update Slack integration |
| DELETE | `/api/repositories/:id/integrations/slack` | Remove Slack integration |

### Per-Session Override (Future)

Allow sessions to override global notification settings:

```typescript
interface SessionNotificationSettings {
  /** Override global rules */
  rules?: Partial<NotificationRules>;

  /** Disable all notifications for this session */
  disabled?: boolean;

  /** Override service configs (e.g., different Slack channel) */
  services?: {
    slack?: Partial<SlackConfig>;
  };
}
```

### Environment Variables

```bash
# Base URL for notification links (required for Slack "Open Session" button)
APP_URL=https://agent-console.example.com
```

> **Note**: Slack webhook URLs are configured per-repository in the database, not via environment variables.

## URL Requirements

For notification URLs to work, Agent Console must be accessible from where users click:

| Deployment | URL | Notes |
|------------|-----|-------|
| Local only | `http://localhost:5555` | Only works on same machine |
| ngrok | `https://abc123.ngrok.io` | URL changes on restart |
| Cloudflare Tunnel | `https://agent.example.com` | Stable URL |
| VPS | `https://agent.example.com` | Stable URL |

Users should configure `baseUrl` appropriately for their deployment.

## State Change Detection and Debouncing

### Notification Trigger Logic

Notifications are only sent when the agent **changes** to a different state. The same state persisting does not trigger repeated notifications.

```
State transitions that trigger notification (if event type enabled):
  idle → waiting  ✓ (notify: agent:waiting)
  active → idle   ✓ (notify: agent:idle)
  idle → idle     ✗ (no change, no notification)
  waiting → waiting ✗ (no change, no notification)
  waiting → idle  ✗ (user action result, no notification needed)
```

> **Note**: `waiting → idle` is skipped because it's the result of user responding to the agent's question. The user already knows about this transition since they triggered it.

### Why Debouncing?

During rapid state changes (e.g., agent quickly toggling between states), debouncing prevents notification spam by waiting for the state to stabilize.

### Implementation

```typescript
class NotificationManager {
  /** Previous state per session:worker for change detection */
  private previousState = new Map<string, NotificationEvent['type']>();

  /** Pending debounce timers per session:worker */
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  onActivityChange(
    session: Session,
    worker: Worker,
    newState: AgentActivityState
  ): void {
    const key = `${session.id}:${worker.id}`;
    const eventType = this.mapActivityToEventType(newState);
    const config = this.getNotificationConfig(session.id);
    const debounce = config.rules.debounce;

    // Clear existing debounce timer
    clearTimeout(this.debounceTimers.get(key));

    // Debounce: wait for state to stabilize
    if (debounce?.debounceSeconds) {
      this.debounceTimers.set(key, setTimeout(() => {
        this.sendIfStateChanged(session, worker, eventType);
      }, debounce.debounceSeconds * 1000));
    } else {
      this.sendIfStateChanged(session, worker, eventType);
    }
  }

  private sendIfStateChanged(
    session: Session,
    worker: Worker,
    eventType: NotificationEvent['type']
  ): void {
    const key = `${session.id}:${worker.id}`;
    const previousType = this.previousState.get(key);

    // Only notify on state change
    if (previousType === eventType) {
      return; // Same state, no notification
    }

    // Update previous state
    this.previousState.set(key, eventType);

    // Send notification
    this.sendNotification(session, worker, eventType);
  }
}
```

### Default Debounce Settings

```typescript
const defaultDebounceSettings: NotificationRules['debounce'] = {
  debounceSeconds: 3,  // Wait 3s for state to stabilize
};
```

## Future Extensions

### Adding New Services

1. Implement `OutboundServiceHandler` interface
2. Register handler in notification router
3. Add service-specific configuration
4. Document service setup

### Example: Discord

```typescript
class DiscordHandler implements OutboundServiceHandler {
  readonly serviceId = 'discord';

  async send(context: NotificationContext): Promise<void> {
    const config = await this.getConfig();

    // Discord webhook format
    const message = {
      content: this.formatContent(context),
      embeds: [this.buildEmbed(context)],
    };

    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  }
}
```

### Example: Email

```typescript
class EmailHandler implements OutboundServiceHandler {
  readonly serviceId = 'email';

  async send(context: NotificationContext): Promise<void> {
    const config = await this.getConfig();
    const statusText = this.getStatusText(context.event.type);

    await this.mailer.send({
      to: config.recipient,
      subject: `[Agent Console] ${context.session.title} - Claude ${statusText}`,
      html: this.buildEmailBody(context),
    });
  }

  private getStatusText(eventType: NotificationEvent['type']): string {
    switch (eventType) {
      case 'agent:waiting': return 'is asking a question';
      case 'agent:idle': return 'has finished';
      case 'agent:active': return 'is processing';
      case 'worker:error': return 'encountered an error';
      case 'worker:exited': return 'process exited';
    }
  }
}
```

### Bidirectional Communication (Future)

While this design focuses on outbound notifications, future integration with messaging platforms could enable:

1. User replies to Slack message
2. Slack sends event to Agent Console (via Slack App Events API)
3. Agent Console writes user's reply to Claude's PTY

This would require:
- Slack App (not just Incoming Webhook)
- Events API endpoint
- Message threading/tracking

## API Reference

### Configuration Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings/notifications` | Get notification settings |
| PUT | `/api/settings/notifications` | Update notification settings |
| POST | `/api/settings/notifications/test` | Send test notification |

### Test Notification

```typescript
// POST /api/settings/notifications/test
{
  "service": "slack",
  "message": "Test notification from Agent Console"
}
```

## Related Documents

- [System Events](./system-events.md) - Event format and type definitions
- [Inbound Integration](./integration-inbound.md) - Receiving events from external systems
- [WebSocket Protocol](./websocket-protocol.md) - Activity state synchronization
