/**
 * Slack notification handler for outbound integrations.
 *
 * Sends formatted notifications to Slack via Incoming Webhooks
 * when agent activity state changes or worker events occur.
 *
 * Note: Webhook URLs are configured at the repository level.
 * The handler looks up the webhook URL from the database when sending.
 */

import { createLogger } from '../../lib/logger.js';
import type {
  OutboundServiceHandler,
  NotificationContext,
} from '@agent-console/shared';
import { getByRepositoryId } from './repository-slack-integration-service.js';

const logger = createLogger('slack-handler');

/**
 * Slack Block Kit section block with optional accessory.
 */
interface SlackSectionBlock {
  type: 'section';
  text: {
    type: 'mrkdwn';
    text: string;
  };
  accessory?: {
    type: 'button';
    text: { type: 'plain_text'; text: string };
    url: string;
    action_id: string;
  };
}

type SlackBlock = SlackSectionBlock;

/**
 * Slack webhook message payload.
 *
 * Note: Modern Slack App webhooks ignore username and icon_emoji fields in the payload.
 * These must be configured in the Slack App settings instead.
 */
interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

/**
 * Slack notification handler.
 *
 * Implements OutboundServiceHandler interface to send notifications
 * to Slack channels via Incoming Webhooks.
 */
export class SlackHandler implements OutboundServiceHandler {
  readonly integrationType = 'slack' as const;

  /**
   * Initialize the Slack handler.
   */
  constructor() {
    logger.info('Slack handler initialized');
  }

  /**
   * Check if this handler can send notifications for the given repository.
   * Returns true if the repository has Slack integration configured and enabled.
   *
   * @param repositoryId - Repository ID to check
   * @returns true if Slack notifications can be sent for this repository
   */
  async canHandle(repositoryId: string): Promise<boolean> {
    const integration = await getByRepositoryId(repositoryId);
    return integration !== null && integration.enabled;
  }

  /**
   * Send notification to Slack for the given repository.
   * Looks up the webhook URL from the repository's Slack integration settings.
   *
   * @param context - Notification context
   * @param repositoryId - Repository ID to send notification for
   * @throws Error if Slack integration is not configured or disabled
   */
  async send(context: NotificationContext, repositoryId: string): Promise<void> {
    const webhookUrl = await this.getWebhookUrl(repositoryId);
    await this.sendToWebhook(context, webhookUrl);
  }

  /**
   * Send a test notification to Slack for a specific repository.
   * Looks up the webhook URL from the repository's Slack integration settings.
   *
   * @param message - Test message to send
   * @param repositoryId - Repository ID to send test notification for
   * @throws Error if Slack integration is not configured or disabled
   */
  async sendTest(message: string, repositoryId: string): Promise<void> {
    const webhookUrl = await this.getWebhookUrl(repositoryId);

    const slackMessage: SlackMessage = {
      text: message,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: message,
          },
        },
      ],
    };

    await this.postToSlack(webhookUrl, slackMessage);
    logger.info('Slack test notification sent successfully');
  }

  /**
   * Get webhook URL for a repository, throwing if not configured or disabled.
   */
  private async getWebhookUrl(repositoryId: string): Promise<string> {
    const integration = await getByRepositoryId(repositoryId);
    if (!integration || !integration.enabled) {
      throw new Error('Slack integration not configured or disabled');
    }
    return integration.webhookUrl;
  }

  /**
   * Send notification to a specific webhook URL.
   * Internal method used by send() after looking up the integration.
   * Made public for testing purposes.
   *
   * @param context - Notification context
   * @param webhookUrl - Webhook URL to send to
   */
  async sendToWebhook(
    context: NotificationContext,
    webhookUrl: string
  ): Promise<void> {
    const message = this.buildMessage(context);

    logger.debug(
      { sessionId: context.session.id, eventType: context.event.type },
      'Sending Slack notification'
    );

    await this.postToSlack(webhookUrl, message);

    logger.info(
      { sessionId: context.session.id, eventType: context.event.type },
      'Slack notification sent successfully'
    );
  }

  /**
   * POST a message to a Slack webhook URL.
   * Handles HTTP errors consistently.
   */
  private async postToSlack(webhookUrl: string, message: SlackMessage): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Slack API error: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Build Slack message from notification context.
   * Formats message with emoji, session info, and "Open Session" button.
   */
  private buildMessage(context: NotificationContext): SlackMessage {
    const { session, event, agentConsoleUrl } = context;
    const sessionName = session.title || session.worktreeId || 'Quick Session';

    const { statusText, statusEmoji } = this.getStatusDisplay(event.type);

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

  /**
   * Get status text and emoji based on event type.
   */
  private getStatusDisplay(eventType: NotificationContext['event']['type']): {
    statusText: string;
    statusEmoji: string;
  } {
    switch (eventType) {
      case 'agent:waiting':
        return { statusText: 'is asking a question', statusEmoji: ':question:' };
      case 'agent:idle':
        return { statusText: 'has finished', statusEmoji: ':white_check_mark:' };
      case 'agent:active':
        return { statusText: 'is processing', statusEmoji: ':hourglass:' };
      case 'worker:error':
        return { statusText: 'encountered an error', statusEmoji: ':x:' };
      case 'worker:exited':
        return { statusText: 'process exited', statusEmoji: ':stop_sign:' };
      default: {
        const _exhaustive: never = eventType;
        throw new Error(`Unhandled event type: ${_exhaustive}`);
      }
    }
  }
}
