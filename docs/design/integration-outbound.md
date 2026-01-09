# Outbound Integration Design

This document describes the design for sending notifications from Agent Console to external systems when Claude Code's state changes.

> **Prerequisite**: See [System Events](./system-events.md) for event format and type definitions.

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

### Flow

```typescript
// Pseudocode for outbound notification flow
class NotificationManager {
  onActivityChange(
    session: Session,
    worker: Worker,
    newState: AgentActivityState
  ): void {
    // 1. Map activity state to event type
    const eventType = this.mapActivityToEventType(newState);

    // 2. Check if notification should be sent
    const config = this.getNotificationConfig(session.id);
    if (!config.rules.triggers[eventType]) return;

    // 3. Build notification context
    const context: NotificationContext = {
      session,
      worker,
      event: {
        type: eventType,
        activityState: newState,
        timestamp: new Date(),
      },
      agentConsoleUrl: this.buildSessionUrl(session, worker),
    };

    // 4. Send to all configured services
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

> **Note**: Outbound integration uses `NotificationEvent` internally rather than `SystemEvent`. This is because outbound notifications are tightly coupled to UI presentation and require different data structures (e.g., `activityState` for status display). The event types align with those defined in [System Events](./system-events.md) but use a simpler internal format.

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
  event: NotificationEvent;
  agentConsoleUrl: string;
}

type NotificationEvent =
  | { type: 'agent:waiting'; activityState: 'waiting'; timestamp: Date }
  | { type: 'agent:idle'; activityState: 'idle'; timestamp: Date }
  | { type: 'agent:active'; activityState: 'active'; timestamp: Date }
  | { type: 'worker:error'; message: string; timestamp: Date }
  | { type: 'worker:exited'; exitCode: number; timestamp: Date };
```

### Notification Rules

```typescript
/** Event types that can trigger outbound notifications */
type OutboundTriggerEventType =
  | 'agent:waiting'
  | 'agent:idle'
  | 'agent:active'
  | 'worker:error'
  | 'worker:exited';

interface NotificationRules {
  /**
   * Events that trigger notifications.
   * Keys are event types from SystemEventType (internal subset).
   */
  triggers: Partial<Record<OutboundTriggerEventType, boolean>>;

  /** Throttling settings */
  throttle?: {
    /** Minimum seconds between notifications for same session */
    minIntervalSeconds: number;
    /** Debounce: only notify if state persists for N seconds */
    debounceSeconds?: number;
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
};
```

## Slack Implementation

### Configuration

```typescript
interface SlackConfig {
  webhookUrl: string;
  enabled: boolean;
  /** Optional: customize message appearance */
  username?: string;
  iconEmoji?: string;
}
```

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

  /** Service configurations */
  services: {
    slack?: SlackConfig;
    // Future services
    discord?: DiscordConfig;
    email?: EmailConfig;
  };
}
```

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
# Base URL for notification links
AGENT_CONSOLE_BASE_URL=https://agent-console.example.com

# Slack webhook URL
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
```

## URL Requirements

For notification URLs to work, Agent Console must be accessible from where users click:

| Deployment | URL | Notes |
|------------|-----|-------|
| Local only | `http://localhost:5555` | Only works on same machine |
| ngrok | `https://abc123.ngrok.io` | URL changes on restart |
| Cloudflare Tunnel | `https://agent.example.com` | Stable URL |
| VPS | `https://agent.example.com` | Stable URL |

Users should configure `baseUrl` appropriately for their deployment.

## Throttling and Debouncing

### Why Throttling?

- Prevent notification spam during rapid state changes
- Reduce noise for users
- Avoid rate limits on external services

### Implementation

```typescript
class ThrottledNotificationManager extends NotificationManager {
  private lastNotification = new Map<string, Date>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  onActivityChange(
    session: Session,
    worker: Worker,
    newState: AgentActivityState
  ): void {
    const key = `${session.id}:${worker.id}`;
    const config = this.getNotificationConfig(session.id);
    const throttle = config.rules.throttle;

    // Debounce: wait for state to stabilize
    if (throttle?.debounceSeconds) {
      clearTimeout(this.debounceTimers.get(key));
      this.debounceTimers.set(key, setTimeout(() => {
        this.sendIfNotThrottled(session, worker, newState, throttle);
      }, throttle.debounceSeconds * 1000));
    } else {
      this.sendIfNotThrottled(session, worker, newState, throttle);
    }
  }

  private sendIfNotThrottled(
    session: Session,
    worker: Worker,
    newState: AgentActivityState,
    throttle?: NotificationRules['throttle']
  ): void {
    const key = `${session.id}:${worker.id}`;
    const lastTime = this.lastNotification.get(key);
    const minInterval = (throttle?.minIntervalSeconds ?? 0) * 1000;

    if (lastTime && Date.now() - lastTime.getTime() < minInterval) {
      return; // Throttled
    }

    this.lastNotification.set(key, new Date());
    super.onActivityChange(session, worker, newState);
  }
}
```

### Default Throttle Settings

```typescript
const defaultThrottleSettings: NotificationRules['throttle'] = {
  minIntervalSeconds: 60,  // Max 1 notification per minute per session
  debounceSeconds: 3,      // Wait 3s for state to stabilize
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
