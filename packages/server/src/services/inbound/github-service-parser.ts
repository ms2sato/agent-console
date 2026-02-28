import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundEventType, SystemEvent } from '@agent-console/shared';
import * as v from 'valibot';
import { createLogger } from '../../lib/logger.js';
import { serverConfig } from '../../lib/server-config.js';
import type { ServiceParser } from './service-parser.js';

const logger = createLogger('github-service-parser');

const RepositorySchema = v.object({
  full_name: v.string(),
});

const HeadRefSchema = v.nullish(v.object({
  ref: v.nullish(v.string()),
}));

const WorkflowRunPayloadSchema = v.object({
  action: v.literal('completed'),
  workflow_run: v.object({
    conclusion: v.string(),
    name: v.string(),
    html_url: v.nullish(v.string()),
    head_branch: v.nullish(v.string()),
    head_sha: v.nullish(v.string()),
    updated_at: v.nullish(v.string()),
  }),
  repository: RepositorySchema,
});

const IssueClosedPayloadSchema = v.object({
  action: v.literal('closed'),
  issue: v.object({
    number: v.number(),
    title: v.string(),
    html_url: v.nullish(v.string()),
    updated_at: v.nullish(v.string()),
  }),
  repository: RepositorySchema,
});

const PullRequestMergedPayloadSchema = v.object({
  action: v.literal('closed'),
  pull_request: v.object({
    merged: v.literal(true),
    number: v.number(),
    title: v.string(),
    html_url: v.nullish(v.string()),
    head: HeadRefSchema,
    merged_at: v.nullish(v.string()),
  }),
  repository: RepositorySchema,
});

const ReviewCommentPayloadSchema = v.object({
  action: v.literal('created'),
  comment: v.object({
    body: v.string(),
    path: v.nullish(v.string()),
    line: v.nullish(v.number()),
    original_line: v.nullish(v.number()),
    html_url: v.nullish(v.string()),
    created_at: v.nullish(v.string()),
    user: v.nullish(v.object({
      login: v.nullish(v.string()),
    })),
  }),
  pull_request: v.object({
    number: v.number(),
    head: HeadRefSchema,
  }),
  repository: RepositorySchema,
});

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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

    const githubEvent = headers.get('x-github-event');
    if (!githubEvent) {
      return null;
    }

    switch (githubEvent) {
      case 'workflow_run':
        return this.parseWorkflowRun(body);
      case 'issues':
        return this.parseIssueClosed(body);
      case 'pull_request':
        return this.parsePullRequest(body);
      case 'pull_request_review_comment':
        return this.parsePullRequestReviewComment(body);
      default:
        return null;
    }
  }

  private parseWorkflowRun(body: unknown): SystemEvent | null {
    const result = v.safeParse(WorkflowRunPayloadSchema, body);
    if (!result.success) {
      logger.debug({ issues: result.issues }, 'workflow_run payload did not match expected schema');
      return null;
    }

    const { workflow_run: workflowRun, repository } = result.output;
    const eventType: InboundEventType = workflowRun.conclusion === 'success' ? 'ci:completed' : 'ci:failed';

    return {
      type: eventType,
      source: 'github',
      timestamp: workflowRun.updated_at ?? new Date().toISOString(),
      metadata: {
        repositoryName: repository.full_name,
        branch: workflowRun.head_branch ?? undefined,
        url: workflowRun.html_url ?? undefined,
        commitSha: workflowRun.head_sha ?? undefined,
      },
      payload: body,
      summary: `${workflowRun.name} ${workflowRun.conclusion}`,
    };
  }

  private parseIssueClosed(body: unknown): SystemEvent | null {
    const result = v.safeParse(IssueClosedPayloadSchema, body);
    if (!result.success) {
      logger.debug({ issues: result.issues }, 'issues payload did not match expected schema');
      return null;
    }

    const { issue, repository } = result.output;

    return {
      type: 'issue:closed',
      source: 'github',
      timestamp: issue.updated_at ?? new Date().toISOString(),
      metadata: {
        repositoryName: repository.full_name,
        url: issue.html_url ?? undefined,
      },
      payload: body,
      summary: `Issue #${issue.number} closed: ${issue.title}`,
    };
  }

  private parsePullRequest(body: unknown): SystemEvent | null {
    const result = v.safeParse(PullRequestMergedPayloadSchema, body);
    if (!result.success) {
      logger.debug({ issues: result.issues }, 'pull_request payload did not match expected schema');
      return null;
    }

    const { pull_request: pr, repository } = result.output;

    return {
      type: 'pr:merged',
      source: 'github',
      timestamp: pr.merged_at ?? new Date().toISOString(),
      metadata: {
        repositoryName: repository.full_name,
        branch: pr.head?.ref ?? undefined,
        url: pr.html_url ?? undefined,
      },
      payload: body,
      summary: `PR #${pr.number} merged: ${pr.title}`,
    };
  }

  private parsePullRequestReviewComment(body: unknown): SystemEvent | null {
    const result = v.safeParse(ReviewCommentPayloadSchema, body);
    if (!result.success) {
      logger.debug({ issues: result.issues }, 'pull_request_review_comment payload did not match expected schema');
      return null;
    }

    const { comment, pull_request: pr, repository } = result.output;
    const line = comment.line ?? comment.original_line ?? null;
    const summary = buildReviewCommentSummary(
      pr.number,
      comment.body,
      comment.user?.login ?? null,
      comment.path ?? null,
      line,
    );

    return {
      type: 'pr:review_comment',
      source: 'github',
      timestamp: comment.created_at ?? new Date().toISOString(),
      metadata: {
        repositoryName: repository.full_name,
        branch: pr.head?.ref ?? undefined,
        url: comment.html_url ?? undefined,
      },
      payload: body,
      summary,
    };
  }
}

function buildReviewCommentSummary(
  prNumber: number,
  commentBody: string,
  userLogin: string | null,
  path: string | null,
  line: number | null
): string {
  let result = `Review comment on PR #${prNumber}`;

  if (userLogin) {
    result += ` by ${truncate(userLogin, 100)}`;
  }
  if (path) {
    const location = line != null ? `${truncate(path, 200)}:${line}` : truncate(path, 200);
    result += ` (${location})`;
  }

  return `${result}: ${truncate(commentBody, 200)}`;
}
