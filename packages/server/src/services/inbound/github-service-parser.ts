import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundEventType, SystemEvent } from '@agent-console/shared';
import { createLogger } from '../../lib/logger.js';
import { serverConfig } from '../../lib/server-config.js';
import type { ServiceParser } from './service-parser.js';

const logger = createLogger('github-service-parser');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function getNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

export class GitHubServiceParser implements ServiceParser {
  readonly serviceId = 'github';
  private webhookSecret: string;

  constructor(webhookSecret: string = serverConfig.GITHUB_WEBHOOK_SECRET) {
    this.webhookSecret = webhookSecret;
  }

  async authenticate(payload: string, headers: Headers): Promise<boolean> {
    if (!this.webhookSecret) {
      logger.warn('GitHub webhook secret not configured');
      return false;
    }

    const signature = headers.get('x-hub-signature-256');
    if (!signature) {
      return false;
    }

    const expected = `sha256=${createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex')}`;

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (signatureBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(signatureBuffer, expectedBuffer);
  }

  async parse(payload: string, headers: Headers): Promise<SystemEvent | null> {
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse GitHub webhook JSON');
      return null;
    }

    if (!isRecord(body)) {
      return null;
    }

    const githubEvent = headers.get('x-github-event');
    if (!githubEvent) {
      return null;
    }

    switch (githubEvent) {
      case 'workflow_run':
        if (getString(body, 'action') !== 'completed') return null;
        return this.parseWorkflowRun(body);
      case 'issues':
        if (getString(body, 'action') !== 'closed') return null;
        return this.parseIssueClosed(body);
      case 'pull_request':
        return this.parsePullRequest(body);
      default:
        return null;
    }
  }

  private parseWorkflowRun(body: Record<string, unknown>): SystemEvent | null {
    const workflowRun = getRecord(body, 'workflow_run');
    const repository = getRecord(body, 'repository');
    if (!workflowRun || !repository) return null;

    const conclusion = getString(workflowRun, 'conclusion');
    const name = getString(workflowRun, 'name');
    const url = getString(workflowRun, 'html_url');
    const branch = getString(workflowRun, 'head_branch');
    const repositoryName = getString(repository, 'full_name');

    if (!conclusion || !name || !repositoryName) return null;

    const eventType: InboundEventType = conclusion === 'success' ? 'ci:completed' : 'ci:failed';

    return {
      type: eventType,
      source: 'github',
      timestamp: getString(workflowRun, 'updated_at') ?? new Date().toISOString(),
      metadata: {
        repositoryName,
        branch: branch ?? undefined,
        url: url ?? undefined,
      },
      payload: body,
      summary: `${name} ${conclusion}`,
    };
  }

  private parseIssueClosed(body: Record<string, unknown>): SystemEvent | null {
    const issue = getRecord(body, 'issue');
    const repository = getRecord(body, 'repository');
    if (!issue || !repository) return null;

    const issueNumber = getNumber(issue, 'number');
    const title = getString(issue, 'title');
    const url = getString(issue, 'html_url');
    const repositoryName = getString(repository, 'full_name');

    if (!issueNumber || !title || !repositoryName) return null;

    return {
      type: 'issue:closed',
      source: 'github',
      timestamp: getString(issue, 'updated_at') ?? new Date().toISOString(),
      metadata: {
        repositoryName,
        url: url ?? undefined,
      },
      payload: body,
      summary: `Issue #${issueNumber} closed: ${title}`,
    };
  }

  private parsePullRequest(body: Record<string, unknown>): SystemEvent | null {
    const action = getString(body, 'action');
    const pullRequest = getRecord(body, 'pull_request');
    const repository = getRecord(body, 'repository');
    if (!pullRequest || !repository) return null;

    const merged = getBoolean(pullRequest, 'merged');
    if (action !== 'closed' || merged !== true) {
      return null;
    }

    const prNumber = getNumber(pullRequest, 'number');
    const title = getString(pullRequest, 'title');
    const url = getString(pullRequest, 'html_url');
    const head = getRecord(pullRequest, 'head');
    const branch = head ? getString(head, 'ref') : null;
    const repositoryName = getString(repository, 'full_name');

    if (!prNumber || !title || !repositoryName) return null;

    return {
      type: 'pr:merged',
      source: 'github',
      timestamp: getString(pullRequest, 'merged_at') ?? new Date().toISOString(),
      metadata: {
        repositoryName,
        branch: branch ?? undefined,
        url: url ?? undefined,
      },
      payload: body,
      summary: `PR #${prNumber} merged: ${title}`,
    };
  }
}
