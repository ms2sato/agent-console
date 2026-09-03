/**
 * MCP (Model Context Protocol) server for AgentConsole.
 *
 * Exposes tools that allow AI agents running inside AgentConsole
 * to programmatically create worktrees, manage sessions, and
 * communicate with other agents.
 *
 * Uses Streamable HTTP transport via @hono/mcp.
 */
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPTransport } from '@hono/mcp';
import { z } from 'zod';
import * as v from 'valibot';
import { randomUUID } from 'node:crypto';

import type { SessionManager } from '../services/session-manager.js';
import type { RepositoryManager } from '../services/repository-manager.js';
import type { AgentManager } from '../services/agent-manager.js';
import type { AgentDirectory } from '../services/agent-directory.js';
import type { TimerManager } from '../services/timer-manager.js';
import type { ConditionalWakeupManager } from '../services/conditional-wakeup-manager.js';
import type { InteractiveProcessManager } from '../services/interactive-process-manager.js';
import type { WorktreeService } from '../services/worktree-service.js';
import type { AnnotationService } from '../services/annotation-service.js';
import { sendAnnotationsToClient } from '../websocket/git-diff-handler.js';
import type { DeleteWorktreeFn } from '../services/worktree-deletion-service.js';
import type { CreateWorktreeWithSessionFn } from '../services/worktree-creation-service.js';
import type { OpenPrInfo } from '../services/github-pr-service.js';
import type { UserRepository } from '../repositories/user-repository.js';
import type { RepositoryUpdates } from '../repositories/repository-repository.js';
import type { ArtifactRepository } from '../repositories/artifact-repository.js';
import type { BookmarkRepository } from '../repositories/bookmark-repository.js';
import { getCurrentBranch } from '../lib/git.js';
import { CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import type { SuggestSessionMetadataFn } from '../services/session-metadata-suggester.js';
import type { InterSessionMessageService } from '../services/inter-session-message-service.js';
import { buildReplyInstructions } from '../lib/pty-notification.js';
import { getRemoteUrl, GitError } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import { serverConfig } from '../lib/server-config.js';
import { resolveRequestUsername } from '../services/resolve-spawn-username.js';
import {
  EmbeddedAgentActivationError,
  GENERIC_EMBEDDED_ACTIVATION_FAILURE_MESSAGE,
} from '../services/embedded-agent-worker-service.js';
import {
  McpTokenRegistry,
  resolveMcpAuthMode,
  type McpAuthMode,
  getMcpCallerIdentity,
  checkCallerOwnsSession,
  createMcpAuthMiddleware,
} from './mcp-auth.js';
import type { Session, Worker, AgentActivityState, AppServerMessage } from '@agent-console/shared';
import {
  isPtyBackedWorker,
  canReceiveSessionMessages,
  canReceiveNotifications,
  CreateBookmarkRequestSchema,
} from '@agent-console/shared';

const logger = createLogger('mcp');

// ---------- Response helpers ----------

interface DelegateResult {
  sessionId: string;
  workerId: string;
  worktreePath: string;
  branch: string;
}

interface SessionStatusResult {
  sessionId: string;
  status: 'active' | 'inactive';
  title?: string;
  worktreeId?: string;
  repositoryId?: string;
  repositoryName?: string;
  parentSessionId?: string;
  parentWorkerId?: string;
  workers: Array<{
    id: string;
    type: Worker['type'];
    activityState: AgentActivityState;
  }>;
}

interface SessionListItem {
  id: string;
  type: 'worktree' | 'quick';
  title?: string;
  worktreeId?: string;
  repositoryId?: string;
  repositoryName?: string;
  parentSessionId?: string;
  parentWorkerId?: string;
  status: 'active' | 'inactive';
  workers: Array<{
    id: string;
    type: Worker['type'];
    activityState: AgentActivityState;
  }>;
}

interface TerminalAgentListItem {
  kind: 'terminal';
  id: string;
  name: string;
  description?: string;
  isBuiltIn: boolean;
  capabilities: {
    supportsContinue: boolean;
    supportsHeadlessMode: boolean;
    supportsActivityDetection: boolean;
  };
}

interface EmbeddedAgentListItem {
  kind: 'embedded';
  id: string;
  name: string;
  description?: string;
}

type AgentListItem = TerminalAgentListItem | EmbeddedAgentListItem;

interface RepositoryListItem {
  id: string;
  name: string;
  remoteUrl?: string;
  description?: string;
}

interface RepositoryUpdateResult {
  id: string;
  name: string;
  remoteUrl?: string;
  description?: string;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  defaultAgentId?: string | null;
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Build a prompt that includes callback instructions telling the delegated agent
 * to report results back to the parent session via send_session_message.
 */
function buildMessageCallbackPrompt(
  prompt: string,
  parentSessionId: string,
  parentWorkerId: string,
): string {
  return `${prompt}
---
[Message Callback Instructions]
You have a parent session that delegated this task to you. Use the \`send_session_message\` MCP tool to communicate with the parent session when needed.

Common parameters for all messages:
- toSessionId: "${parentSessionId}"
- toWorkerId: "${parentWorkerId}"
- fromSessionId: Use your AGENT_CONSOLE_SESSION_ID environment variable

When to send a message:

1. **Task completion**: After completing this task (whether successful or not), you MUST report your results back.
   - content: A concise summary of what you accomplished, the outcome (success/failure), and any important details the caller needs to know.

2. **PR merged**: When you receive a \`[inbound:pr:merged]\` notification indicating your PR has been merged, notify the parent immediately.
   - content: Report that the PR was merged, including the PR URL and any relevant details.

3. **Questions or concerns**: When you encounter uncertainty, blocking issues, or need a decision from the parent, send a consultation message instead of making assumptions.
   - content: Clearly describe the question or concern, the options you've considered, and what you recommend (if applicable). Then wait for a response before proceeding.`;
}

/** 5 MiB, measured on the raw received `content` string's UTF-8 byte length (docs/design/html-artifacts.md §1 req. 5). */
const MAX_ARTIFACT_CONTENT_BYTES = 5 * 1024 * 1024;

const HTML_TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HTML_HEADING_TAG_RE = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i;

/**
 * Cap on a resolved artifact title's length, in characters, applied after
 * stripping/collapsing (never before -- truncating raw markup could sever a
 * tag mid-span and leave an unclosed `<`). 200 is a generous bound for
 * display metadata (sidebar/tab labels) while still bounding worst-case
 * storage/render cost for a caller-supplied title with no natural limit.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Strip HTML tags from an already-extracted fragment and collapse whitespace,
 * for title display only. Repeats the tag-strip pass to a fixed point (rather
 * than a single pass) so that any tag-like span exposed by a previous
 * removal is also stripped -- this closes CodeQL's
 * `js/incomplete-multi-character-sanitization` finding for this call site.
 */
function stripHtmlTagsAndCollapseWhitespace(fragment: string): string {
  let stripped = fragment;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== previous);
  return stripped.replace(/\s+/g, ' ').trim();
}

/** Truncate an already-stripped title to MAX_TITLE_LENGTH characters. */
function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
}

/**
 * Resolve an artifact's display title per the chain in
 * docs/design/html-artifacts.md §5.3: explicit `title` param -> the
 * document's `<title>` -> its first heading (`<h1>`..`<h6>`) -> the literal
 * fallback "Untitled" (an artifact id is never used as a display title).
 *
 * Resolved titles are always plain text: every rung of the chain -- the
 * explicit `title` param included, since it is caller-supplied and equally
 * capable of carrying markup as the extracted `<title>`/heading text -- is
 * passed through `stripHtmlTagsAndCollapseWhitespace` and capped at
 * MAX_TITLE_LENGTH characters before being returned. Only the literal
 * "Untitled" fallback is exempt, being a fixed string. This makes the DB
 * value safe for every consumer that reads it back (UI, MCP tool results,
 * etc.), not merely the ones fed by markup extraction.
 *
 * Regex-based on purpose: this extracts metadata for display only and never
 * mutates the stored bytes (the artifact is served byte-verbatim per §3), so
 * a lightweight heuristic is sufficient here -- a full HTML parser
 * dependency is not warranted for this single call site.
 *
 * @internal Exported for testing.
 */
export function resolveArtifactTitle(content: string, titleParam: string | undefined): string {
  const trimmedParam = titleParam?.trim();
  if (trimmedParam) {
    const stripped = stripHtmlTagsAndCollapseWhitespace(trimmedParam);
    if (stripped) return truncateTitle(stripped);
  }

  const titleMatch = HTML_TITLE_TAG_RE.exec(content);
  if (titleMatch) {
    const extracted = stripHtmlTagsAndCollapseWhitespace(titleMatch[1]);
    if (extracted) return truncateTitle(extracted);
  }

  const headingMatch = HTML_HEADING_TAG_RE.exec(content);
  if (headingMatch) {
    const extracted = stripHtmlTagsAndCollapseWhitespace(headingMatch[1]);
    if (extracted) return truncateTitle(extracted);
  }

  return 'Untitled';
}

/**
 * Build the `create_html_artifact` tool result shape per
 * docs/design/html-artifacts.md §4.1: `url` present only when
 * `publicOrigin` is configured; `note` explains its absence otherwise.
 * Extracted as a pure function so both branches are directly
 * unit-testable without depending on the `serverConfig` module-singleton's
 * import-time environment-variable evaluation (which cannot be toggled
 * mid-test-process).
 *
 * @internal Exported for testing.
 */
export function buildArtifactToolResult(
  artifactId: string,
  publicOrigin: string | undefined,
): { artifactId: string; path: string; url?: string; note?: string } {
  const path = `/artifacts/${artifactId}`;
  if (publicOrigin) {
    return { artifactId, path, url: `${publicOrigin}${path}` };
  }
  return {
    artifactId,
    path,
    note:
      'AGENT_CONSOLE_PUBLIC_ORIGIN is not configured on this server; only a relative path is available. ' +
      'Set AGENT_CONSOLE_PUBLIC_ORIGIN to also receive an absolute URL.',
  };
}

// ---------- Dependencies ----------

export interface McpDependencies {
  sessionManager: SessionManager;
  repositoryManager: RepositoryManager;
  agentManager: AgentManager;
  /**
   * Cross-registry agent lookup (agent-surface migration PR-A). Backs `list_agents`
   * (listAll) and `delegate_to_worktree`'s agentId/agentName resolver
   * (resolve). Absorbs the #1165 short-term facade verbatim -- same
   * precedence (terminal-first by id) and ambiguity error messages.
   * `agentManager` above remains a separate dep, used only for the
   * headless branch/title suggestion path, which stays terminal-only.
   */
  agentDirectory: Pick<AgentDirectory, 'listAll' | 'resolve'>;
  timerManager: TimerManager;
  conditionalWakeupManager: ConditionalWakeupManager;
  interactiveProcessManager: InteractiveProcessManager;
  worktreeService: WorktreeService;
  annotationService: AnnotationService;
  interSessionMessageService: InterSessionMessageService;
  suggestSessionMetadata: SuggestSessionMetadataFn;
  createWorktreeWithSession: CreateWorktreeWithSessionFn;
  deleteWorktree: DeleteWorktreeFn;
  /**
   * User repository used by `delegate_to_worktree` to resolve the parent
   * session's `createdBy` (a user UUID) to its OS `username`, which is then
   * threaded down to `createWorktreeWithSession` as `requestUsername` so
   * that `git worktree add` runs as the requesting user in multi-user mode.
   */
  userRepository: UserRepository;
  /** HTML artifact metadata + storage repository, backing `create_html_artifact` (see docs/design/html-artifacts.md). */
  artifactRepository: ArtifactRepository;
  /** Bookmark repository, backing `create_bookmark` / `delete_bookmark` (see docs/design/session-bookmarks.md). */
  bookmarkRepository: BookmarkRepository;
  broadcastToApp: (msg: AppServerMessage) => void;
  /**
   * Fetch PR URL for a branch. 3rd arg is `requestUsername`, threaded by
   * the MCP caller resolving `session.createdBy` -> `username`.
   */
  fetchPullRequestUrl: (
    branch: string,
    cwd: string,
    requestUsername: string | null,
  ) => Promise<string | null>;
  /** Find open PR for a branch; `requestUsername` threading mirrors `fetchPullRequestUrl`. */
  findOpenPullRequest: (
    branch: string,
    cwd: string,
    requestUsername: string | null,
  ) => Promise<OpenPrInfo | null>;
  /**
   * Registry of per-worker MCP bearer tokens (spec:
   * docs/design/embedded-agent-worker.md § "MCP caller identity").
   * Defaults to an empty registry; token minting/delivery lands in later
   * phases, so with the default every call is tokenless.
   */
  mcpTokenRegistry?: McpTokenRegistry;
  /**
   * Override for the resolved AGENT_CONSOLE_MCP_AUTH mode (tests).
   * Defaults to resolveMcpAuthMode() (env resolution; default `warn`).
   */
  mcpAuthMode?: McpAuthMode;
}

// ---------- Factory ----------

/**
 * Create the MCP Hono app with injected dependencies.
 *
 * All MCP tool handlers use the provided dependencies instead of singleton getters.
 */
export function createMcpApp(deps: McpDependencies): Hono {
  const { sessionManager, repositoryManager, agentManager, agentDirectory, timerManager, conditionalWakeupManager, interactiveProcessManager, worktreeService, annotationService, interSessionMessageService, suggestSessionMetadata, createWorktreeWithSession, deleteWorktree, userRepository, artifactRepository, bookmarkRepository, broadcastToApp, findOpenPullRequest } = deps;

  // MCP caller identity (spec: docs/design/embedded-agent-worker.md § "MCP
  // caller identity"). The registry defaults to empty and the mode resolves
  // from AGENT_CONSOLE_MCP_AUTH, defaulting to `warn` for every AUTH_MODE
  // (Sprint 2026-07-16 decision: `enforce`-by-default for multi-user was
  // deferred); tests override both. Passing `serverConfig.AUTH_MODE`
  // explicitly (rather than relying on the parameter default reading
  // `process.env.AUTH_MODE` directly) keeps this resolution on the same
  // canonical source as the `serverConfig.AUTH_MODE` check two lines below.
  const mcpTokenRegistry = deps.mcpTokenRegistry ?? new McpTokenRegistry();
  const mcpAuthMode = deps.mcpAuthMode ?? resolveMcpAuthMode(undefined, serverConfig.AUTH_MODE);
  if (serverConfig.AUTH_MODE === 'multi-user' && mcpAuthMode === 'warn') {
    logger.info('MCP caller identity running in warn mode for AUTH_MODE=multi-user; this is currently the default (opt into stricter checking via AGENT_CONSOLE_MCP_AUTH=enforce). Restoring enforce-by-default is tracked in Issue #1107 (docs/design/embedded-agent-worker.md § "MCP caller identity")');
  }

  /**
   * Map a public Session to the worker info format used by MCP tool responses.
   */
  function mapWorkers(session: Session): SessionStatusResult['workers'] {
    return session.workers.map((w) => ({
      id: w.id,
      type: w.type,
      activityState:
        w.type === 'agent' || w.type === 'embedded-agent'
          ? sessionManager.getWorkerActivityState(session.id, w.id) ?? 'unknown'
          : ('unknown' as AgentActivityState),
    }));
  }

  // ---------- MCP Server setup ----------

  const mcpServer = new McpServer({
    name: 'agent-console',
    version: '1.0.0',
  });

  // ---------- Tool: list_agents ----------

  mcpServer.tool(
    'list_agents',
    'List all registered agents in AgentConsole (both terminal and embedded). Returns agent IDs, names, ' +
      'descriptions, kind, and (for terminal agents) capabilities. ' +
      'Use this to discover available agents before calling delegate_to_worktree.',
    {},
    async () => {
      try {
        const entries = agentDirectory.listAll();

        const result: AgentListItem[] = entries.map((entry) => {
          if (entry.kind === 'terminal') {
            return {
              kind: 'terminal',
              id: entry.agent.id,
              name: entry.agent.name,
              description: entry.agent.description,
              isBuiltIn: entry.agent.isBuiltIn,
              capabilities: entry.agent.capabilities,
            };
          }
          return {
            kind: 'embedded',
            id: entry.agent.id,
            name: entry.agent.name,
            description: entry.agent.description,
          };
        });

        return textResult({ agents: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err }, 'list_agents failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: list_repositories ----------

  mcpServer.tool(
    'list_repositories',
    'List all registered repositories in AgentConsole. Returns repository IDs, names, remote URLs, and brief descriptions. ' +
      'Use this to discover available repositories before calling delegate_to_worktree with a specific repositoryId.',
    {},
    async () => {
      try {
        const repos = repositoryManager.getAllRepositories();

        const result: RepositoryListItem[] = await Promise.all(
          repos.map(async (repo) => ({
            id: repo.id,
            name: repo.name,
            remoteUrl: (await getRemoteUrl(repo.path)) ?? undefined,
            description: repo.description ?? undefined,
          })),
        );

        return textResult({ repositories: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err }, 'list_repositories failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: update_repository ----------

  mcpServer.tool(
    'update_repository',
    'Update a registered repository\'s configuration. Fields that can be updated: setupCommand, cleanupCommand, envVars, description, defaultAgentId. Omit a field to leave it unchanged; pass an empty string or null to clear it. NOTE: envVars is stored plaintext in the database until an encryption story ships — do not persist secrets here.',
    {
      repositoryId: z.string().min(1).describe('The repository ID to update'),
      setupCommand: z.string().nullish().describe('Shell command to run after creating worktrees. Empty string or null clears the value.'),
      cleanupCommand: z.string().nullish().describe('Shell command to run before deleting worktrees. Empty string or null clears the value.'),
      envVars: z.string().nullish().describe('Environment variables in .env format applied to workers. Stored plaintext; do not persist secrets.'),
      description: z.string().nullish().describe('Brief description of the repository. Empty string or null clears the value.'),
      defaultAgentId: z.string().nullish().describe('Default agent ID for worktree creation. Empty string or null clears the value.'),
    },
    async ({ repositoryId, setupCommand, cleanupCommand, envVars, description, defaultAgentId }) => {
      try {
        const updates: RepositoryUpdates = {};
        if (setupCommand !== undefined) updates.setupCommand = setupCommand;
        if (cleanupCommand !== undefined) updates.cleanupCommand = cleanupCommand;
        if (envVars !== undefined) updates.envVars = envVars;
        if (description !== undefined) updates.description = description;
        if (defaultAgentId !== undefined) updates.defaultAgentId = defaultAgentId;

        const updated = await repositoryManager.updateRepository(repositoryId, updates);
        if (!updated) {
          return errorResult(`Repository not found: ${repositoryId}`);
        }

        const remoteUrl = (await getRemoteUrl(updated.path)) ?? undefined;
        const result: RepositoryUpdateResult = {
          id: updated.id,
          name: updated.name,
          remoteUrl,
          description: updated.description ?? undefined,
          setupCommand: updated.setupCommand ?? null,
          cleanupCommand: updated.cleanupCommand ?? null,
          defaultAgentId: updated.defaultAgentId ?? null,
        };
        return textResult({ repository: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, repositoryId }, 'update_repository failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: list_sessions ----------

  mcpServer.tool(
    'list_sessions',
    'List all active sessions in AgentConsole. Returns session IDs, types, titles, and worker activity states.',
    {},
    async () => {
      try {
        const sessions = sessionManager.getAllSessions();

        const result: SessionListItem[] = sessions.map((s) => {
          const base: SessionListItem = {
            id: s.id,
            type: s.type,
            title: s.title,
            status: s.status,
            workers: mapWorkers(s),
            parentSessionId: s.parentSessionId,
            parentWorkerId: s.parentWorkerId,
          };
          if (s.type === 'worktree') {
            base.worktreeId = s.worktreeId;
            base.repositoryId = s.repositoryId;
            base.repositoryName = s.repositoryName;
          }
          return base;
        });

        return textResult({ sessions: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err }, 'list_sessions failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: get_session_status ----------

  mcpServer.tool(
    'get_session_status',
    'Get the status of a specific session, including worker activity states.',
    {
      sessionId: z.string().describe('The session ID to check'),
    },
    async ({ sessionId }) => {
      try {
        const session = sessionManager.getSession(sessionId);

        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }

        const result: SessionStatusResult = {
          sessionId: session.id,
          status: session.status,
          title: session.title,
          workers: mapWorkers(session),
          parentSessionId: session.parentSessionId,
          parentWorkerId: session.parentWorkerId,
        };

        if (session.type === 'worktree') {
          result.worktreeId = session.worktreeId;
          result.repositoryId = session.repositoryId;
          result.repositoryName = session.repositoryName;
        }

        return textResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId }, 'get_session_status failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: send_session_message ----------

  mcpServer.tool(
    'send_session_message',
    'Send a message to a worker in another session via file. ' +
      'The message is written as a file and the target worker receives a PTY notification. ' +
      'If toWorkerId is omitted and the session has exactly one agent worker, it is auto-selected. ' +
      'The calling agent can get its own session ID from the AGENT_CONSOLE_SESSION_ID environment variable.',
    {
      toSessionId: z.string().describe('Target session ID'),
      toWorkerId: z.string().optional().describe(
        'Target worker ID. If omitted, auto-selects the sole agent worker in the target session.',
      ),
      content: z.string().describe('Message content (free-form)'),
      fromSessionId: z.string().describe(
        'The sender session ID. The calling agent can get this from the AGENT_CONSOLE_SESSION_ID environment variable.',
      ),
    },
    async ({ toSessionId, toWorkerId, content, fromSessionId }) => {
      try {
        // 1. Validate target session
        const targetSession = sessionManager.getSession(toSessionId);
        if (!targetSession) {
          return errorResult(`Session ${toSessionId} not found`);
        }

        // 2. Resolve target worker
        let resolvedWorkerId: string;
        if (toWorkerId) {
          const worker = targetSession.workers.find((w) => w.id === toWorkerId);
          if (!worker) {
            return errorResult(`Worker ${toWorkerId} not found in session ${toSessionId}`);
          }
          if (!isPtyBackedWorker(worker) && !canReceiveSessionMessages(worker)) {
            return errorResult(
              `Worker ${toWorkerId} in session ${toSessionId} cannot receive inbound messages: requires a PTY-backed worker (agent/terminal) or an embedded-agent worker`,
            );
          }
          resolvedWorkerId = toWorkerId;
        } else {
          const agentWorkers = targetSession.workers.filter(canReceiveSessionMessages);
          if (agentWorkers.length === 0) {
            return errorResult(`Session ${toSessionId} has no agent workers`);
          }
          if (agentWorkers.length > 1) {
            const workerIds = agentWorkers.map((w) => w.id).join(', ');
            return errorResult(
              `Session ${toSessionId} has multiple agent workers (${workerIds}). ` +
                `Specify toWorkerId explicitly. ` +
                `Use get_session_status to discover available workers.`,
            );
          }
          resolvedWorkerId = agentWorkers[0].id;
        }

        // Resolve the actual Worker object so the delivery step below can
        // branch on `.type` (embedded-agent vs PTY-backed).
        const resolvedWorker = targetSession.workers.find((w) => w.id === resolvedWorkerId);

        // 3. Validate sender session (defense-in-depth against agents that pass
        //    a stale or hallucinated fromSessionId).
        //    The agent is expected to source this from AGENT_CONSOLE_SESSION_ID,
        //    but LLM-driven tool calls have been observed substituting an unrelated
        //    session id intermittently. Rejecting unknown senders fails fast so
        //    the agent can self-correct, and prevents Reply Instructions from
        //    being generated with an unreplyable target.
        const senderSession = sessionManager.getSession(fromSessionId);
        if (!senderSession) {
          return errorResult(
            `Sender session ${fromSessionId} not found. ` +
              `fromSessionId must reference an existing session — ` +
              `agents should source it from the AGENT_CONSOLE_SESSION_ID environment variable.`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId: fromSessionId, createdBy: senderSession.createdBy },
          mcpAuthMode,
          { toolName: 'send_session_message' },
        );
        if (authError) return errorResult(authError.error);

        // 4. Resolve the path via SessionManager so we use the canonical
        //    persisted slug — the in-memory `repositoryName` is a display
        //    name that may differ from the on-disk slug.
        const resolver = sessionManager.getPathResolverForSessionId(toSessionId);
        if (!resolver) {
          return errorResult(`Cannot resolve data path for target session ${toSessionId}`);
        }
        const result = await interSessionMessageService.sendMessage({
          toSessionId,
          toWorkerId: resolvedWorkerId,
          fromSessionId,
          content,
          resolver,
        });

        // 5. Deliver the notification to the target worker via the single
        //    delivery seam (SessionManager.deliverWorkerNotification), which
        //    branches on the target's worker kind internally (PTY write vs
        //    EmbeddedAgentWorkerService.sendSystemNotification -- the latter
        //    also activates a dormant worker on delivery, so no separate
        //    activateEmbeddedAgentWorker call is needed here).
        const senderTitle = senderSession.title ?? fromSessionId;
        const notificationParams = {
          kind: 'internal-message' as const,
          tag: 'internal:message' as const,
          fields: {
            source: 'session',
            from: fromSessionId,
            summary: `Message from session ${senderTitle}`,
            path: result.path,
          },
          intent: 'triage' as const,
        };

        if (resolvedWorker?.type === 'embedded-agent') {
          // Embedded branch: a HARD failure -- no best-effort try/catch --
          // the tool call fails with a classified message rather than
          // silently dropping the notification. `replyToSessionId` is
          // threaded through so the delivered/persisted text carries reply
          // instructions, matching what the PTY branch below writes
          // separately.
          const deliveryResult = await sessionManager.deliverWorkerNotification(
            toSessionId,
            resolvedWorkerId,
            notificationParams,
            { replyToSessionId: fromSessionId },
          );
          if (!deliveryResult.ok) {
            logger.warn(
              { toSessionId, toWorkerId: resolvedWorkerId, error: deliveryResult.error },
              'Embedded-agent message delivery failed on send_session_message path',
            );
            return errorResult(`Failed to deliver message to embedded agent: ${deliveryResult.error}`);
          }
        } else {
          // PTY notification (best-effort -- message file is already
          // written, so a delivery failure here is logged, not surfaced as
          // a tool error). The seam's PTY-backed branch does not compose
          // reply instructions (see deliverWorkerNotification's doc
          // comment) -- send_session_message is the sole caller that wants
          // them, so it appends them itself, as a second write, only after
          // the notification itself was delivered successfully (mirroring
          // the pre-seam behavior, where a failed notification write never
          // reached the reply-instructions write either).
          const deliveryResult = await sessionManager.deliverWorkerNotification(
            toSessionId,
            resolvedWorkerId,
            notificationParams,
          );
          if (!deliveryResult.ok) {
            logger.warn(
              { toSessionId, toWorkerId: resolvedWorkerId, error: deliveryResult.error },
              'PTY notification failed (message file was written successfully)',
            );
          } else {
            try {
              sessionManager.writeWorkerInput(toSessionId, resolvedWorkerId, buildReplyInstructions(fromSessionId));
            } catch (notifyErr) {
              logger.warn(
                { err: notifyErr, toSessionId, toWorkerId: resolvedWorkerId },
                'Reply instructions write failed (message file was written successfully)',
              );
            }
          }
        }

        return textResult({
          messageId: result.messageId,
          path: result.path,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, toSessionId, toWorkerId }, 'send_session_message failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: delegate_to_worktree ----------

  mcpServer.tool(
    'delegate_to_worktree',
    'Create a new worktree, start a session with an agent, and send a prompt. ' +
      'Use this to delegate work to a new agent running in an isolated worktree. ' +
      'Note: once started, the worktree and session persist on the server even if the MCP client disconnects. ' +
      'To delegate to a repository other than your own, use list_repositories to discover available repositories. ' +
      'Requires parentSessionId and parentWorkerId, from your own AGENT_CONSOLE_SESSION_ID / AGENT_CONSOLE_WORKER_ID ' +
      'environment variables (every legitimate caller holds both). The parent session determines the delegated ' +
      "session's ownership (createdBy inheritance) -- this is not a reporting convenience. By default, callback " +
      'instructions are appended to the prompt so the delegated agent reports results back via send_session_message; ' +
      'set skipMessageCallbackPrompt to suppress that.',
    {
      repositoryId: z.string().describe(
        'The repository ID. The calling agent can get this from the AGENT_CONSOLE_REPOSITORY_ID environment variable. ' +
          'To delegate to a different repository, call list_repositories first to discover available repository IDs.',
      ),
      prompt: z
        .string()
        .min(1, 'Prompt is required')
        .max(5000, 'Prompt must be under 5000 characters')
        .describe('The task description / prompt for the new agent'),
      baseBranch: z
        .string()
        .optional()
        .describe('Base branch to create from (defaults to repository default branch)'),
      branch: z
        .string()
        .optional()
        .describe('Explicit branch name. If omitted, a name is auto-generated from the prompt.'),
      agentId: z
        .string()
        .optional()
        .describe(
          `Agent to use. If omitted, falls back to the repository's configured default agent, ` +
            `then to ${CLAUDE_CODE_AGENT_ID}.`,
        ),
      agentName: z
        .string()
        .optional()
        .describe(
          'Agent name to use. Resolved to agentId by exact match. ' +
            'Ignored when agentId is also provided. ' +
            'Errors if zero or multiple agents match the name.',
        ),
      title: z.string().optional().describe('Human-readable session title'),
      useRemote: z
        .boolean()
        .optional()
        .describe('Branch from origin/<baseBranch> instead of local branch. Defaults to true when omitted.'),
      parentSessionId: z
        .string()
        .min(1, 'parentSessionId must be non-empty')
        .describe(
          "Required. The parent session's ID, from your own AGENT_CONSOLE_SESSION_ID environment variable. " +
            "The parent session determines the delegated session's ownership (createdBy is inherited from it) -- " +
            'this is not just a reporting convenience. Callback instructions are appended to the prompt (unless ' +
            'skipMessageCallbackPrompt is set) so the delegated agent reports results back via send_session_message.',
        ),
      parentWorkerId: z
        .string()
        .min(1, 'parentWorkerId must be non-empty')
        .describe(
          "Required. The parent session's worker ID, from your own AGENT_CONSOLE_WORKER_ID environment variable. " +
            'Must name an existing worker in that session capable of receiving send_session_message ' +
            '(an agent or embedded-agent worker).',
        ),
      skipMessageCallbackPrompt: z
        .boolean()
        .optional()
        .describe(
          'When true, skip auto-appending callback instructions to the prompt. ' +
            'Use this when you want to include your own custom reporting instructions in the prompt.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Model override for the initial worker. For a terminal agent, only accepted when its command ' +
            'template declares a model template variable (e.g. via an optional-argument placeholder); ' +
            "for an embedded agent, accepted per its engine's capability table. Rejected otherwise, " +
            'naming the reason. Pass-through, not validated against a model catalog.',
        ),
      reasoningEffort: z
        .string()
        .optional()
        .describe(
          'Reasoning-effort override for the initial worker. For a terminal agent, only accepted when ' +
            'its command template declares a reasoning-effort template variable; for an embedded agent, ' +
            "accepted per its engine's capability table (which may also enforce a closed accepted-values " +
            'list, e.g. low/medium/high/xhigh/max). Rejected otherwise, naming the reason.',
        ),
      contextWindowTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Context-window override for the initial worker. Only accepted alongside a `model` override ' +
            'for an embedded agent (agent-surface.md Ruling 4) -- a model override without a declared ' +
            "window disables automatic compaction rather than silently reusing the previous model's " +
            'window. Rejected for terminal agents (no repository-side window concept) and rejected ' +
            'without an accompanying `model` override.',
        ),
      templateVars: z
        .record(z.string(), z.string())
        .optional()
        .refine(
          (vars) => !vars || Object.keys(vars).every((key) => /^\w+$/.test(key)),
          'Template variable keys must be alphanumeric/underscore only'
        )
        .refine(
          (vars) => !vars || Object.keys(vars).every((key) => key !== 'prompt' && key !== 'cwd'),
          'Cannot override reserved template variables: prompt, cwd'
        )
        .describe(
          'Custom template variable overrides. Keys are variable names (e.g., "model"), values are the replacement strings. ' +
            'These override default values defined in the agent command template (e.g., {{model:claude-opus-4-6}}), ' +
            'or supply an optional CLI argument declared as {{model:+--model}} (present only when a value is given). ' +
            'For the built-in Claude Code agent, {"model": "<model-name-or-id>"} adds --model <value> to the spawned ' +
            'command; the value is passed through as-is (not validated), so its accepted form is Claude Code\'s own contract.',
        ),
    },
    async ({
      repositoryId,
      prompt,
      baseBranch,
      branch,
      agentId,
      agentName,
      title,
      useRemote,
      parentSessionId,
      parentWorkerId,
      skipMessageCallbackPrompt,
      model,
      reasoningEffort,
      contextWindowTokens,
      templateVars,
    }) => {
      try {
        // Build effective prompt with optional callback instructions.
        // parentSessionId/parentWorkerId are required by the schema, so the
        // only thing gating the append is skipMessageCallbackPrompt -- the
        // old truthy check on both ids is now dead code since the schema
        // makes their absence unrepresentable.
        const effectivePrompt = skipMessageCallbackPrompt
          ? prompt
          : buildMessageCallbackPrompt(prompt, parentSessionId, parentWorkerId);

        // Validate repository
        const repo = repositoryManager.getRepository(repositoryId);
        if (!repo) {
          return errorResult(`Repository not found: ${repositoryId}`);
        }

        // Resolve agent: agentId takes precedence over agentName. Delegates
        // cross-registry lookup to AgentDirectory.resolve (agent-surface migration PR-A),
        // absorbing the #1165 facade verbatim: id checks AgentManager (terminal)
        // first, falling back to EmbeddedAgentManager; a name matching agents in
        // both registries is rejected as ambiguous.
        let selectedAgentId: string | undefined;
        let selectedEmbeddedAgentId: string | undefined;
        if (agentId || agentName) {
          const resolution = agentDirectory.resolve({ agentId, agentName });
          if (!resolution.ok) {
            return errorResult(resolution.message);
          }
          if (resolution.entry.kind === 'terminal') {
            selectedAgentId = resolution.entry.agent.id;
          } else {
            selectedEmbeddedAgentId = resolution.entry.agent.id;
          }
        } else {
          selectedAgentId = repo.defaultAgentId ?? CLAUDE_CODE_AGENT_ID;
        }

        // `agent` (a terminal AgentDefinition) drives suggestSessionMetadata's
        // headless branch/title generation below regardless of the initial
        // worker's own type -- embedded agents have no headless CLI template
        // for branch-name suggestion (mirrors the REST worktree-creation
        // route's terminal-agent fallback, packages/server/src/routes/worktrees.ts).
        const suggestionAgentId = selectedAgentId ?? repo.defaultAgentId ?? CLAUDE_CODE_AGENT_ID;
        const agent = agentManager.getAgent(suggestionAgentId);
        if (!agent) {
          return errorResult(`Agent not found: ${suggestionAgentId}`);
        }

        // Resolve the parent session and inherit its createdBy for
        // ownership. Both checks below are required-but-unresolvable
        // errors: the schema only guarantees the ids are non-empty
        // strings, not that they name a real, owned session. A stale
        // parentSessionId or a legacy parent with no createdBy used to
        // degrade silently to a null-owned, dead-agent session -- the
        // incident this Issue closes.
        //
        // Guard order is load-bearing: session-exists -> createdBy-set ->
        // caller-owns -> worker-resolves. Several tests assert an earlier
        // guard's error while passing a placeholder parentWorkerId that
        // would fail the later worker-resolution guard too; hoisting worker
        // resolution above the createdBy check would flip those tests'
        // expected error without making the guard itself wrong.
        const parentSession = sessionManager.getSession(parentSessionId);
        if (!parentSession) {
          return errorResult(`Parent session not found: ${parentSessionId}`);
        }
        if (!parentSession.createdBy) {
          return errorResult(
            `Parent session ${parentSessionId} has no createdBy; delegation from an ownerless (legacy) session is not possible`,
          );
        }
        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId: parentSessionId, createdBy: parentSession.createdBy },
          mcpAuthMode,
          { toolName: 'delegate_to_worktree' },
        );
        if (authError) return errorResult(authError.error);
        const parentCreatedBy = parentSession.createdBy;

        // Resolve parentWorkerId against the PARENT session's own workers
        // (never a global lookup) and require it to name a worker capable
        // of receiving send_session_message. Unconditional: the id is
        // stored on the child session and exported as
        // AGENT_CONSOLE_PARENT_WORKER_ID regardless of
        // skipMessageCallbackPrompt, and an unresolvable id poisons every
        // callback the delegated agent will ever attempt (it is embedded
        // verbatim into the standing prompt instructions below).
        const parentWorker = parentSession.workers.find((w) => w.id === parentWorkerId);
        if (!parentWorker) {
          return errorResult(`Parent worker not found in session ${parentSessionId}: ${parentWorkerId}`);
        }
        if (!canReceiveSessionMessages(parentWorker)) {
          return errorResult(
            `Parent worker ${parentWorkerId} cannot receive session messages (type: ${parentWorker.type})`,
          );
        }

        // Resolve parent's createdBy (a users.id UUID) to its OS username
        // so the suggestion call and `git worktree add` both run as the
        // requesting user in multi-user mode. When the UUID does not resolve
        // (orphan sessions), `requestUsername` is null and `runAsUser`
        // bypasses elevation — current behaviour preserved. Resolution
        // shared with `run_process` / `create_conditional_wakeup` via
        // `resolveRequestUsername` (see `.claude/rules/elevation-helpers.md`).
        const requestUsername = await resolveRequestUsername(
          parentCreatedBy,
          userRepository,
          { toolName: 'delegate_to_worktree', repositoryId },
        );

        // Build the SSH_AUTH_SOCK fallback path from the parent user's
        // home so delegated worktree sessions in multi-user mode inherit
        // a working 1Password SSH socket. Only populated when the parent's
        // createdBy resolves to a real user record (mirrors the
        // null-bypass contract of resolveRequestUsername above). Without
        // this, the elevation step strips SSH_AUTH_SOCK and git commit
        // signing fails to reach the 1Password agent. The corresponding
        // consumer (buildElevationArgs) emits a conditional `if
        // SSH_AUTH_SOCK unset && socket exists; then export` snippet --
        // the file-existence check makes the value safe to pass even if
        // 1Password isn't installed on the target user.
        let sshAuthSockFallback: string | undefined;
        if (parentCreatedBy) {
          const parentUser = await userRepository.findById(parentCreatedBy);
          if (parentUser?.homeDir) {
            sshAuthSockFallback = `${parentUser.homeDir}/.1password/agent.sock`;
          }
        }

        // Determine branch name
        let effectiveBranch: string;
        let effectiveTitle = title;

        if (branch) {
          // Explicit branch name provided
          effectiveBranch = branch;
        } else {
          // Auto-generate branch name from prompt. The suggestion's headless
          // `claude -p ...` invocation runs via `runAsUser` with the same
          // resolved parent OS username threaded into `git worktree add`
          // below, so in multi-user mode it picks up the user's per-user
          // Claude auth instead of running as the server process user.
          const suggestion = await suggestSessionMetadata({
            prompt: prompt.trim(),
            repositoryPath: repo.path,
            agent,
            requestUser: requestUsername,
          });
          if (suggestion.error || !suggestion.branch) {
            effectiveBranch = `task-${Date.now()}`;
            logger.warn(
              { error: suggestion.error },
              'Branch name generation failed, using fallback',
            );
          } else {
            effectiveBranch = suggestion.branch;
            effectiveTitle = title ?? suggestion.title;
          }
        }

        // Determine base branch
        const effectiveBaseBranch =
          baseBranch ??
          (await worktreeService.getDefaultBranch(repo.path)) ??
          'main';

        const result = await createWorktreeWithSession({
          repoPath: repo.path,
          repoId: repositoryId,
          repoName: repo.name,
          setupCommand: repo.setupCommand,
          branch: effectiveBranch,
          baseBranch: effectiveBaseBranch,
          useRemote: useRemote !== false,
          agentId: selectedAgentId,
          embeddedAgentId: selectedEmbeddedAgentId,
          model,
          reasoningEffort,
          contextWindowTokens,
          initialPrompt: effectivePrompt,
          title: effectiveTitle,
          autoStartSession: true,
          context: {
            parentSessionId,
            parentWorkerId,
            createdBy: parentCreatedBy,
            templateVars,
            // Thread the 1Password socket fallback through to
            // SessionManager.createSession -> InternalSession -> PTY spawn.
            sshAuthSockFallback,
          },
          requestUsername,
        }, sessionManager, worktreeService);

        if (!result.success) {
          return errorResult(`Worktree creation failed: ${result.error}`);
        }

        // Re-check session still exists after async gap.
        // Session may have been deleted concurrently during creation.
        const session = result.session!;
        const currentSession = sessionManager.getSession(session.id);
        if (!currentSession) {
          logger.warn(
            { sessionId: session.id, repositoryId },
            'Session deleted during delegate_to_worktree, rolling back worktree',
          );
          // Rollback the created worktree since the session no longer exists.
          // Thread the same `requestUsername` resolved above so the rollback
          // also runs as the worktree-owning user in multi-user mode —
          // otherwise it would hit the same Permission-denied failure mode.
          try {
            await worktreeService.removeWorktree(repo.path, result.worktree!.path, true, requestUsername);
          } catch (cleanupErr) {
            logger.warn(
              { worktreePath: result.worktree!.path, err: cleanupErr },
              'Failed to clean up worktree during rollback',
            );
          }
          return errorResult('Session was deleted before delegation could complete');
        }

        // Find the initial worker ID from the created session. The initial
        // worker is either a terminal agent or an embedded agent, depending
        // on which registry `selectedAgentId` / `selectedEmbeddedAgentId`
        // resolved from above.
        const agentWorker = currentSession.workers.find(
          (w) => w.type === 'agent' || w.type === 'embedded-agent',
        );
        if (!agentWorker) {
          return errorResult('Session created but no agent worker was found');
        }

        // Delegate-path-only activation: the delegate path is the only place
        // that knows no browser tab is coming for this worker, so it activates an
        // embedded-agent initial worker itself here, through the SAME
        // idempotent entry point the worker WebSocket open handler uses
        // (`activateEmbeddedAgentWorker` -> websocket/routes.ts). A later
        // browser open on this worker hits that entry's existing
        // already-activated no-op guard -- no second activation entry point,
        // no new activation semantics. Terminal-agent workers are unaffected:
        // they already spawn their PTY at session-creation time
        // (worker-lifecycle-manager.ts).
        if (agentWorker.type === 'embedded-agent') {
          try {
            await sessionManager.activateEmbeddedAgentWorker(session.id, agentWorker.id);
          } catch (err) {
            // Only the enumerable, developer-authored reasons (marked by
            // EmbeddedAgentActivationError) are safe to forward verbatim --
            // identical classification to websocket/routes.ts. The created
            // worktree/session are NOT rolled back: this is the delegate
            // path's only failure channel, and the resulting state (session
            // exists, its agent failed to start) mirrors what a UI-created
            // activation failure already leaves behind.
            const message =
              err instanceof EmbeddedAgentActivationError ? err.message : GENERIC_EMBEDDED_ACTIVATION_FAILURE_MESSAGE;
            logger.warn(
              { sessionId: session.id, workerId: agentWorker.id, err },
              'Embedded-agent auto-activation failed on delegate path',
            );
            return errorResult(
              `Session ${session.id} was created but its embedded agent failed to activate: ${message}`,
            );
          }
        }

        const delegateResult: DelegateResult = {
          sessionId: session.id,
          workerId: agentWorker.id,
          worktreePath: result.worktree!.path,
          branch: result.worktree!.branch,
        };

        logger.info(
          { sessionId: session.id, branch: result.worktree!.branch, repositoryId },
          'Worktree delegation completed via MCP',
        );

        return textResult(delegateResult);
      } catch (err) {
        if (err instanceof GitError) {
          logger.error({ err, repositoryId }, 'delegate_to_worktree failed (git error)');
          return errorResult(`Git operation failed: ${err.message}`);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, repositoryId }, 'delegate_to_worktree failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: close_session ----------

  mcpServer.tool(
    'close_session',
    'WARNING: For worktree sessions, prefer mcp__agent-console__remove_worktree instead. ' +
      'Using close_session alone leaves the agent-console worktree entity orphaned ' +
      '(visible in the top-level UI but no longer removable via MCP tools once the ' +
      'sessionId is invalidated). close_session should be used ONLY when you explicitly ' +
      'want to preserve the git worktree directory and branch. ' +
      'This tool closes a session and cleans up its workers; for worktree sessions, ' +
      'the worktree directory on disk is not removed.',
    {
      sessionId: z.string().describe('The session ID to close'),
    },
    async ({ sessionId }) => {
      try {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }

        const deleted = await sessionManager.deleteSession(sessionId);
        if (!deleted) {
          return errorResult(`Failed to delete session: ${sessionId}`);
        }

        logger.info({ sessionId }, 'Session closed via MCP');

        return textResult({ sessionId, deleted: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId }, 'close_session failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: write_memo ----------

  mcpServer.tool(
    'write_memo',
    'Write a Markdown memo for the current session. The memo is displayed in the UI and persists across conversations. ' +
      'Use this to leave notes, status updates, or summaries that the user can see at a glance without scrolling through conversation history.',
    {
      sessionId: z.string().describe('The session ID to write the memo for'),
      content: z.string().refine(
        (s) => Buffer.byteLength(s, 'utf-8') <= 256 * 1024,
        { message: 'Memo content must not exceed 256KB' },
      ).describe('Markdown content for the memo'),
    },
    async ({ sessionId, content }) => {
      try {
        const filePath = await sessionManager.writeMemo(sessionId, content);
        logger.info({ sessionId }, 'Memo written via MCP');
        return textResult({ success: true, sessionId, filePath });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId }, 'write_memo failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: remove_worktree ----------

  mcpServer.tool(
    'remove_worktree',
    'Remove a git worktree and its associated session. ' +
      'This runs the repository cleanup command (if configured), kills PTY processes, ' +
      'removes the worktree via git, and deletes the session. ' +
      'If worktree removal fails, the session is preserved for retry.',
    {
      sessionId: z.string().describe(
        'The session ID of the worktree session to remove. ' +
          'Use list_sessions to discover session IDs.',
      ),
      force: z
        .boolean()
        .optional()
        .describe('Force-remove the worktree even if it has uncommitted changes (default false)'),
    },
    async ({ sessionId, force }) => {
      try {
        // 1. Resolve session to get repoId and worktreePath (MCP-specific: receives sessionId)
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }

        if (session.type !== 'worktree') {
          return errorResult(
            `Session ${sessionId} is not a worktree session. Use close_session instead.`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'remove_worktree' },
        );
        if (authError) return errorResult(authError.error);

        // 2. Resolve the session's `createdBy` (a users.id UUID) to its OS
        //    username so multiple elevation points run as the worktree-owning
        //    user in multi-user mode: (a) `git worktree remove` + fallback
        //    `rm -rf`, and (b) `findOpenPullRequest`'s `gh pr list` open-PR
        //    check. When `createdBy` is unset or the UUID does not resolve
        //    (legacy / orphan sessions), `requestUsername` is null and
        //    `runAsUser` bypasses elevation — current behaviour preserved.
        //    Resolution shared with `delegate_to_worktree` / `run_process` /
        //    `create_conditional_wakeup` via `resolveRequestUsername` (see
        //    `.claude/rules/elevation-helpers.md`). The MCP caller-auth
        //    binding is enforced above via `checkCallerOwnsSession`
        //    (docs/design/embedded-agent-worker.md § "MCP caller identity").
        const requestUsername = await resolveRequestUsername(
          session.createdBy,
          userRepository,
          { toolName: 'remove_worktree', sessionId },
        );

        // 3. Delegate all domain logic to service
        const result = await deleteWorktree(
          {
            repoId: session.repositoryId,
            worktreePath: session.locationPath,
            force: force ?? false,
            requestUsername,
          },
          { worktreeService, sessionManager, repositoryManager, findOpenPullRequest, getCurrentBranch },
        );

        if (!result.success) {
          return errorResult(result.error || 'Failed to remove worktree');
        }

        if (result.sessionDeleteError) {
          return errorResult(`Worktree was removed but session cleanup failed: ${result.sessionDeleteError}`);
        }

        logger.info(
          { sessionId, worktreePath: session.locationPath },
          'Worktree and session removed via MCP',
        );

        return textResult({
          sessionId,
          worktreePath: session.locationPath,
          removed: true,
          cleanupCommandResult: result.cleanupCommandResult,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId }, 'remove_worktree failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: create_timer ----------

  mcpServer.tool(
    'create_timer',
    'Create a periodic timer that sends notifications to a worker at specified intervals. ' +
      'Use this to set up recurring callbacks for monitoring tasks, checking CI status, etc. ' +
      'The worker can be an agent, terminal, or embedded-agent worker. ' +
      'The timer fires an [internal:timer] notification on each tick -- delivered as a PTY write for ' +
      'agent/terminal workers, or as a queued turn for embedded-agent workers. ' +
      'Timers are volatile and will not survive server restarts.',
    {
      sessionId: z.string().describe(
        'The session to receive timer notifications. ' +
          'Use AGENT_CONSOLE_SESSION_ID environment variable for your own session.',
      ),
      workerId: z.string().describe(
        'The worker to receive timer notifications. ' +
          'Use AGENT_CONSOLE_WORKER_ID environment variable for your own worker.',
      ),
      intervalSeconds: z
        .number()
        .int()
        .min(10, 'Minimum interval is 10 seconds')
        .max(86400, 'Maximum interval is 86400 seconds (24 hours)')
        .describe('Interval between ticks in seconds (min 10, max 86400)'),
      action: z
        .string()
        .min(1, 'Action is required')
        .max(500, 'Action must be under 500 characters')
        .describe('Description of what to do on each tick (included in the notification)'),
    },
    async ({ sessionId, workerId, intervalSeconds, action }) => {
      try {
        // Validate session and worker exist
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session ${sessionId} not found`);
        }
        const worker = session.workers.find((w) => w.id === workerId);
        if (!worker) {
          return errorResult(`Worker ${workerId} not found in session ${sessionId}`);
        }
        if (!canReceiveNotifications(worker)) {
          return errorResult(
            `Worker ${workerId} in session ${sessionId} cannot receive notifications: requires an agent, terminal, or embedded-agent worker`,
          );
        }

        const timer = timerManager.createTimer({
          sessionId,
          workerId,
          intervalSeconds,
          action,
        });

        return textResult({
          timerId: timer.id,
          sessionId: timer.sessionId,
          workerId: timer.workerId,
          intervalSeconds: timer.intervalSeconds,
          action: timer.action,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId, workerId }, 'create_timer failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: delete_timer ----------

  mcpServer.tool(
    'delete_timer',
    'Delete a periodic timer. The timer stops firing immediately.',
    {
      timerId: z.string().describe('The timer ID returned by create_timer'),
    },
    async ({ timerId }) => {
      try {
        const deleted = timerManager.deleteTimer(timerId);
        if (!deleted) {
          return errorResult(`Timer not found: ${timerId}`);
        }
        return textResult({ deleted: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, timerId }, 'delete_timer failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: create_conditional_wakeup ----------

  mcpServer.tool(
    'create_conditional_wakeup',
    'Create a conditional wakeup that checks a shell command at intervals and sends notification only when the condition becomes true (exit 0) or timeout is reached. ' +
      'Silent polling preserves LLM context windows by avoiding unnecessary notifications. ' +
      'The worker can be an agent, terminal, or embedded-agent worker. ' +
      'Returns a wakeup ID for cancellation. The wakeup auto-stops after sending one notification.',
    {
      sessionId: z.string().describe(
        'The session to receive wakeup notifications. ' +
          'Use AGENT_CONSOLE_SESSION_ID environment variable for your own session.',
      ),
      workerId: z.string().describe(
        'The worker to receive the wakeup. ' +
          'Usually the current agent worker. Use AGENT_CONSOLE_WORKER_ID if available.',
      ),
      intervalSeconds: z.number().int().min(30).max(86400).describe(
        'How often to check the condition (30-86400 seconds). ' +
          'E.g., 30 for every 30 seconds, 300 for every 5 minutes.',
      ),
      conditionScript: z.string().describe(
        'Shell command to check condition. Exit 0 = condition true, non-zero = condition false. ' +
          'Example: "gh pr view 698 --json mergeStateStatus --jq .mergeStateStatus | grep -q CLEAN"',
      ),
      onTrueMessage: z.string().describe(
        'Message to send when condition becomes true. ' +
          'Example: "PR #698 is ready for merge (status: CLEAN)"',
      ),
      timeoutSeconds: z.number().int().min(60).max(86400).optional().describe(
        'Optional timeout in seconds. If provided, sends timeout message and stops after this duration.',
      ),
      onTimeoutMessage: z.string().optional().describe(
        'Optional message to send on timeout. If omitted, uses a default timeout message.',
      ),
    },
    async ({ sessionId, workerId, intervalSeconds, conditionScript, onTrueMessage, timeoutSeconds, onTimeoutMessage }) => {
      try {
        // Validate session and worker exist
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session ${sessionId} not found`);
        }
        const worker = session.workers.find((w) => w.id === workerId);
        if (!worker) {
          return errorResult(`Worker ${workerId} not found in session ${sessionId}`);
        }
        if (!canReceiveNotifications(worker)) {
          return errorResult(
            `Worker ${workerId} in session ${sessionId} cannot receive notifications: requires an agent, terminal, or embedded-agent worker`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'create_conditional_wakeup' },
        );
        if (authError) return errorResult(authError.error);

        // Resolve the session's createdBy (a users.id UUID) to its OS
        // `username` so the condition-script process runs as the requesting
        // user in multi-user mode. When `createdBy` is unset or the UUID
        // does not resolve (legacy / orphan sessions), `requestUsername` is
        // null and the underlying `spawnAsUser` bypasses elevation --
        // single-user behaviour preserved. Resolution shared with
        // `run_process` / `delegate_to_worktree` via `resolveRequestUsername`
        // (see `.claude/rules/elevation-helpers.md`).
        const requestUsername = await resolveRequestUsername(
          session.createdBy,
          userRepository,
          { toolName: 'create_conditional_wakeup', sessionId },
        );

        const wakeup = conditionalWakeupManager.createWakeup({
          sessionId,
          workerId,
          intervalSeconds,
          conditionScript,
          onTrueMessage,
          timeoutSeconds,
          onTimeoutMessage,
          requestUsername,
        });

        return textResult({
          wakeupId: wakeup.id,
          sessionId: wakeup.sessionId,
          workerId: wakeup.workerId,
          intervalSeconds: wakeup.intervalSeconds,
          conditionScript: wakeup.conditionScript,
          timeoutSeconds: wakeup.timeoutSeconds,
          status: wakeup.status,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId, workerId }, 'create_conditional_wakeup failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: delete_conditional_wakeup ----------

  mcpServer.tool(
    'delete_conditional_wakeup',
    'Delete a conditional wakeup. The condition checking stops immediately.',
    {
      wakeupId: z.string().describe('The wakeup ID returned by create_conditional_wakeup'),
    },
    async ({ wakeupId }) => {
      try {
        const deleted = conditionalWakeupManager.deleteWakeup(wakeupId);
        if (!deleted) {
          return errorResult(`Conditional wakeup not found: ${wakeupId}`);
        }
        return textResult({ deleted: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, wakeupId }, 'delete_conditional_wakeup failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: list_timers ----------

  mcpServer.tool(
    'list_timers',
    'List active periodic timers. Optionally filter by session ID.',
    {
      sessionId: z.string().optional().describe('Filter timers by session ID'),
    },
    async ({ sessionId }) => {
      try {
        const timers = timerManager.listTimers(sessionId);
        return textResult({ timers });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err }, 'list_timers failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: run_process ----------

  mcpServer.tool(
    'run_process',
    'Start an interactive script connected to a session. ' +
      'The script drives workflow via STDOUT and blocks on STDIN waiting for responses via write_process_response. ' +
      'Set outputMode="message" to keep long-paragraph script I/O out of the calling agent\'s PTY conversation. ' +
      'Processes are volatile and will not survive server restarts.',
    {
      command: z
        .string()
        .min(1, 'Command is required')
        .describe('Command to execute (e.g., "node acceptance-check.js 526")'),
      sessionId: z.string().describe(
        'The session to receive STDOUT notifications. ' +
          'Use AGENT_CONSOLE_SESSION_ID environment variable for your own session.',
      ),
      workerId: z.string().describe(
        'The worker to receive STDOUT notifications. ' +
          'Use AGENT_CONSOLE_WORKER_ID environment variable for your own worker.',
      ),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory for the command. Defaults to server CWD if omitted.',
        ),
      outputMode: z
        .enum(['pty', 'message'])
        .optional()
        .describe(
          'Routing mode for script I/O. ' +
            '"pty" (default): script stdout is delivered as [internal:process] PTY notifications with full content. ' +
            '"message": script stdout and write_process_response content are routed via inter-session message files ' +
            '(toSessionId/toWorkerId match this run_process call); the PTY receives only a brief notification with ' +
            'the message file path and byte count. ' +
            'Use "message" for long-paragraph interactive scripts (e.g., acceptance-check.js, sprint-retro.js) to keep the conversation clean.',
        ),
    },
    async ({ command, sessionId, workerId, cwd, outputMode }) => {
      try {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session ${sessionId} not found`);
        }
        const worker = session.workers.find((w) => w.id === workerId);
        if (!worker) {
          return errorResult(`Worker ${workerId} not found in session ${sessionId}`);
        }
        if (!isPtyBackedWorker(worker)) {
          return errorResult(
            `Worker ${workerId} in session ${sessionId} does not support PTY notifications: requires a PTY-backed worker (agent/terminal)`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'run_process' },
        );
        if (authError) return errorResult(authError.error);

        // Resolve the session's createdBy (a users.id UUID) to its OS
        // `username` so the spawned process runs as the requesting user in
        // multi-user mode. When `createdBy` is unset or the UUID does not
        // resolve (legacy / orphan sessions), `requestUsername` is null and
        // the underlying `spawnAsUser` bypasses elevation -- single-user
        // behaviour preserved. Resolution shared with `delegate_to_worktree`
        // / `create_conditional_wakeup` via `resolveRequestUsername`
        // (see `.claude/rules/elevation-helpers.md`).
        const requestUsername = await resolveRequestUsername(
          session.createdBy,
          userRepository,
          { toolName: 'run_process', sessionId },
        );

        const process = await interactiveProcessManager.runProcess({
          sessionId,
          workerId,
          command,
          cwd,
          outputMode,
          requestUser: requestUsername,
        });

        return textResult({
          processId: process.id,
          sessionId: process.sessionId,
          workerId: process.workerId,
          command: process.command,
          outputMode: process.outputMode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId, workerId }, 'run_process failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: write_process_response ----------

  mcpServer.tool(
    'write_process_response',
    'Send a response to a waiting interactive process. ' +
      'Writes content to the process STDIN followed by a null byte to unblock reading. ' +
      'The process may then produce more STDOUT output.',
    {
      processId: z.string().describe('The process ID returned by run_process'),
      content: z.string().describe('Response content to send to the process'),
    },
    async ({ processId, content }) => {
      try {
        const process = interactiveProcessManager.getProcess(processId);
        if (!process) {
          return errorResult(`Process not found: ${processId}`);
        }

        const written = await interactiveProcessManager.writeResponse(processId, content);
        if (!written) {
          return errorResult(`Failed to write to process ${processId} (process may have exited)`);
        }

        return textResult({ written: true, processId });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, processId }, 'write_process_response failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: kill_process ----------

  mcpServer.tool(
    'kill_process',
    'Terminate a running interactive process. Sends SIGTERM and cleans up resources.',
    {
      processId: z.string().describe('The process ID returned by run_process'),
    },
    async ({ processId }) => {
      try {
        const killed = interactiveProcessManager.killProcess(processId);
        if (!killed) {
          return errorResult(`Process not found: ${processId}`);
        }
        return textResult({ killed: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, processId }, 'kill_process failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: list_processes ----------

  mcpServer.tool(
    'list_processes',
    'List all interactive processes. Use this after agent restart to rediscover running processes.',
    {},
    async () => {
      try {
        const processes = interactiveProcessManager.listProcesses();
        return textResult({ processes });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err }, 'list_processes failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: write_review_annotations ----------

  mcpServer.tool(
    'write_review_annotations',
    'Write review annotations for a git-diff worker. ' +
      'Marks specific sections of a diff as "needs review" so the user can focus on important changes. ' +
      'Annotations are pushed to the connected client in real-time via WebSocket.',
    {
      workerId: z.string().describe('The git-diff worker ID to annotate'),
      sessionId: z.string().describe('The session ID containing the worker'),
      annotations: z.array(z.object({
        file: z.string().min(1, 'File path is required'),
        startLine: z.number().int().min(1, 'startLine must be >= 1'),
        endLine: z.number().int().min(1, 'endLine must be >= 1'),
        reason: z.string().min(1, 'Reason is required'),
      })).describe('Array of review annotations'),
      summary: z.object({
        totalFiles: z.number().int().min(0),
        reviewFiles: z.number().int().min(0),
        mechanicalFiles: z.number().int().min(0),
        confidence: z.enum(['high', 'medium', 'low']),
      }).describe('Summary of the review analysis'),
      sourceSessionId: z.string().optional().describe('Source session ID that requested the review (e.g., orchestrator). When provided, this becomes a review queue item.'),
    },
    async ({ workerId, sessionId, annotations, summary, sourceSessionId }) => {
      try {
        // Validate session exists
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }

        // Validate worker exists and is a git-diff worker
        const worker = session.workers.find((w) => w.id === workerId);
        if (!worker) {
          return errorResult(`Worker ${workerId} not found in session ${sessionId}`);
        }
        if (worker.type !== 'git-diff') {
          return errorResult(
            `Worker ${workerId} is not a git-diff worker (type: ${worker.type})`,
          );
        }

        // Store annotations (validation happens inside the service)
        const annotationSet = annotationService.setAnnotations(
          workerId,
          { annotations, summary },
          { sourceSessionId, sessionId },
        );

        // Push to connected client (best-effort: annotations are already stored)
        try {
          sendAnnotationsToClient(workerId, annotationSet);
        } catch (notifyErr) {
          logger.warn(
            { err: notifyErr, sessionId, workerId },
            'Failed to push annotations to client (annotations were stored successfully)',
          );
        }

        // Notify app-level clients when a review queue item is created
        if (sourceSessionId) {
          broadcastToApp({ type: 'review-queue-updated' });
        }

        logger.info(
          { sessionId, workerId, annotationCount: annotations.length, sourceSessionId },
          'Review annotations written via MCP',
        );

        return textResult({
          workerId,
          annotationCount: annotationSet.annotations.length,
          createdAt: annotationSet.createdAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId, workerId }, 'write_review_annotations failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: clear_review_annotations ----------

  mcpServer.tool(
    'clear_review_annotations',
    'Clear all review annotations for a git-diff worker. ' +
      'The client is notified immediately via WebSocket.',
    {
      workerId: z.string().describe('The git-diff worker ID to clear annotations for'),
      sessionId: z.string().describe('The session ID containing the worker'),
    },
    async ({ workerId, sessionId }) => {
      try {
        // Validate session exists
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }

        // Validate worker exists and is a git-diff worker
        const worker = session.workers.find((w) => w.id === workerId);
        if (!worker) {
          return errorResult(`Worker ${workerId} not found in session ${sessionId}`);
        }
        if (worker.type !== 'git-diff') {
          return errorResult(
            `Worker ${workerId} is not a git-diff worker (type: ${worker.type})`,
          );
        }

        // Check if this was a review queue item before clearing
        const existingAnnotations = annotationService.getAnnotations(workerId);
        const wasReviewQueueItem = existingAnnotations?.sourceSessionId != null;

        annotationService.clearAnnotations(workerId);

        // Push null to connected client (best-effort: annotations are already cleared)
        try {
          sendAnnotationsToClient(workerId, null);
        } catch (notifyErr) {
          logger.warn(
            { err: notifyErr, sessionId, workerId },
            'Failed to push annotation clear to client (annotations were cleared successfully)',
          );
        }

        // Notify app-level clients when a review queue item is removed
        if (wasReviewQueueItem) {
          broadcastToApp({ type: 'review-queue-updated' });
        }

        logger.info({ sessionId, workerId }, 'Review annotations cleared via MCP');

        return textResult({ cleared: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId, workerId }, 'clear_review_annotations failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: restart_all_agents ----------

  mcpServer.tool(
    'restart_all_agents',
    'Restart all workers with a live process across all sessions: PTY-based agent ' +
      'workers and active embedded-agent workers. ' +
      'Useful when agents have been updated and need to be restarted in bulk. ' +
      'Terminal workers are always left untouched. A dormant (idle-evicted) ' +
      'embedded-agent worker is reported as skipped rather than restarted, since ' +
      'reactivating it would defeat the point of idle eviction.',
    {},
    async () => {
      try {
        const result = await sessionManager.restartAllAgentWorkers();
        return textResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err }, 'restart_all_agents failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: create_html_artifact ----------

  // Sixth session-claiming tool (checkCallerOwnsSession), alongside
  // send_session_message, delegate_to_worktree, remove_worktree,
  // create_conditional_wakeup, run_process, delete_html_artifact,
  // create_bookmark, and delete_bookmark. No mechanical registry
  // enumerates these tools; this comment is the convention-only marker.
  mcpServer.tool(
    'create_html_artifact',
    'Upload an HTML document (optionally with inline JavaScript/CSS) and receive a URL to view it in a browser. ' +
      'Artifacts are stored per-user and persist until manually deleted. ' +
      `Content is capped at ${MAX_ARTIFACT_CONTENT_BYTES} bytes (5 MiB), measured on the raw content string.`,
    {
      content: z.string().min(1, 'Content is required').describe(
        'The HTML document content (max 5 MiB, measured as raw UTF-8 bytes). Served byte-verbatim.',
      ),
      title: z.string().optional().describe(
        'Optional display title. When omitted, derived from the document\'s <title>, then its first heading, ' +
          'then falls back to the literal "Untitled". Markup is stripped and the result is capped at ' +
          `${MAX_TITLE_LENGTH} characters; titles are always plain text.`,
      ),
      sessionId: z.string().describe(
        "The calling session's ID, used to attribute the artifact to that session's owner (session.createdBy). " +
          'Use your own AGENT_CONSOLE_SESSION_ID environment variable.',
      ),
    },
    async ({ content, title, sessionId }) => {
      try {
        const contentByteLength = Buffer.byteLength(content, 'utf-8');
        if (contentByteLength > MAX_ARTIFACT_CONTENT_BYTES) {
          return errorResult(
            `Content exceeds the maximum artifact size of ${MAX_ARTIFACT_CONTENT_BYTES} bytes (5 MiB); ` +
              `received ${contentByteLength} bytes`,
          );
        }

        // Resolve the calling session. Attribution below MUST derive from
        // session.createdBy, NEVER from getMcpCallerIdentity() -- the same
        // layering McpCallerIdentity's JSDoc in mcp-auth.ts documents:
        // MCP caller identity authorizes, the session ownership chain
        // attributes. getMcpCallerIdentity() is used ONLY for
        // checkCallerOwnsSession below.
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }
        if (!session.createdBy) {
          return errorResult(
            `Session ${sessionId} has no createdBy; creating an artifact from an ownerless (legacy) session is not possible`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'create_html_artifact' },
        );
        if (authError) return errorResult(authError.error);

        const resolvedTitle = resolveArtifactTitle(content, title);
        const artifact = await artifactRepository.create({
          id: randomUUID(),
          userId: session.createdBy,
          title: resolvedTitle,
          content,
          sourceSessionId: sessionId,
        });

        logger.info(
          { artifactId: artifact.id, sessionId, userId: session.createdBy, sizeBytes: artifact.sizeBytes },
          'HTML artifact created',
        );

        broadcastToApp({ type: 'artifact-created', sessionId, artifactId: artifact.id });

        // AGENT_CONSOLE_PUBLIC_ORIGIN is the ONLY source for an absolute
        // URL here. MCP tool calls arrive over the localhost dial-back
        // connection, so the /mcp request's Host header (if any) names the
        // wrong machine for a human viewer opening this link from
        // elsewhere -- deliberately never read here
        // (docs/design/html-artifacts.md §4.1).
        return textResult(buildArtifactToolResult(artifact.id, serverConfig.AGENT_CONSOLE_PUBLIC_ORIGIN));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId }, 'create_html_artifact failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: delete_html_artifact ----------

  // Seventh session-claiming tool (checkCallerOwnsSession), alongside
  // send_session_message, delegate_to_worktree, remove_worktree,
  // create_conditional_wakeup, run_process, create_html_artifact,
  // create_bookmark, and delete_bookmark. No mechanical registry
  // enumerates these tools; this comment is the convention-only marker.
  mcpServer.tool(
    'delete_html_artifact',
    'Permanently delete a previously created HTML artifact. This is irreversible: any URL already shared for ' +
      "this artifact will stop working. To change the content behind an already-shared URL, delete and " +
      're-create is NOT equivalent (the URL changes); an in-place update is not available yet.',
    {
      artifactId: z.string().describe('The id of the artifact to delete, as returned by create_html_artifact.'),
      sessionId: z.string().describe(
        "The calling session's ID, used to resolve that session's owner (session.createdBy) for the ownership " +
          'check. Use your own AGENT_CONSOLE_SESSION_ID environment variable.',
      ),
    },
    async ({ artifactId, sessionId }) => {
      try {
        // Resolve the calling session. Ownership comparison below MUST
        // derive from session.createdBy, NEVER from getMcpCallerIdentity()
        // -- same layering as create_html_artifact above:
        // getMcpCallerIdentity() is used ONLY for checkCallerOwnsSession.
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }
        if (!session.createdBy) {
          return errorResult(
            `Session ${sessionId} has no createdBy; deleting an artifact from an ownerless (legacy) session is not possible`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'delete_html_artifact' },
        );
        if (authError) return errorResult(authError.error);

        const artifact = await artifactRepository.findById(artifactId);
        if (!artifact) {
          return errorResult(`Artifact not found: ${artifactId}`);
        }
        if (artifact.userId !== session.createdBy) {
          return errorResult(
            `You do not own this artifact (${artifactId}); only the owner can delete it`,
          );
        }

        const deleted = await artifactRepository.delete(artifactId);
        if (!deleted) {
          // Deleted between the existence check and delete (race); idempotent-style not-found, matching the REST route.
          return errorResult(`Artifact not found: ${artifactId}`);
        }

        logger.info({ artifactId, sessionId, userId: session.createdBy }, 'HTML artifact deleted via MCP');

        // The trigger's sessionId names the OWNING session (whose panel
        // query this artifact was listed under) -- resolved from the
        // record, never from the deleting call's own sessionId param. The
        // two coincide for create but diverge whenever a caller deletes an
        // artifact from a different session than the one that created it
        // (e.g. an orchestrator session cleaning up a delegate session's
        // artifacts) -- using the deleting session there would tell the
        // WRONG panel to refetch and leave the artifact's actual owning
        // panel stale. Falls back to the deleting session only in the
        // (currently unreachable in production, since create_html_artifact
        // always sets sourceSessionId) case of a null sourceSessionId.
        broadcastToApp({ type: 'artifact-deleted', sessionId: artifact.sourceSessionId ?? sessionId, artifactId });

        return textResult({ deleted: true, artifactId });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, artifactId, sessionId }, 'delete_html_artifact failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: create_bookmark ----------

  // Eighth session-claiming tool (checkCallerOwnsSession), alongside
  // send_session_message, delegate_to_worktree, remove_worktree,
  // create_conditional_wakeup, run_process, create_html_artifact,
  // delete_html_artifact, and delete_bookmark. No mechanical registry
  // enumerates these tools; this comment is the convention-only marker.
  mcpServer.tool(
    'create_bookmark',
    'Register a URL (plus an optional title) as a bookmark, visible in the session sidebar. ' +
      'The URL scheme must be http: or https:; other schemes are rejected.',
    {
      url: z.string().describe('The URL to bookmark. Must use the http: or https: scheme.'),
      title: z.string().optional().describe(
        'Optional display title (max 200 characters). When omitted, the client displays the URL instead.',
      ),
      sessionId: z.string().describe(
        "The calling session's ID, used to attribute the bookmark to that session's owner (session.createdBy). " +
          'Use your own AGENT_CONSOLE_SESSION_ID environment variable.',
      ),
    },
    async ({ url, title, sessionId }) => {
      try {
        // CreateBookmarkRequestSchema is the SINGLE writer of scheme and
        // length validation (docs/design/session-bookmarks.md §8) -- the
        // zod shape above validates only shape, never re-implements the
        // scheme allowlist or the title length cap.
        const result = v.safeParse(CreateBookmarkRequestSchema, { url, title, sessionId });
        if (!result.success) {
          return errorResult(result.issues.map((issue) => issue.message).join('; '));
        }

        // Resolve the calling session. Attribution below MUST derive from
        // session.createdBy, NEVER from getMcpCallerIdentity() -- the same
        // layering McpCallerIdentity's JSDoc in mcp-auth.ts documents:
        // MCP caller identity authorizes, the session ownership chain
        // attributes. getMcpCallerIdentity() is used ONLY for
        // checkCallerOwnsSession below.
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }
        if (!session.createdBy) {
          return errorResult(
            `Session ${sessionId} has no createdBy; creating a bookmark from an ownerless (legacy) session is not possible`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'create_bookmark' },
        );
        if (authError) return errorResult(authError.error);

        const created = await bookmarkRepository.create({
          id: randomUUID(),
          userId: session.createdBy,
          url: result.output.url,
          title: result.output.title && result.output.title.length > 0 ? result.output.title : null,
          sourceSessionId: sessionId,
          origin: 'agent',
        });

        logger.info(
          { bookmarkId: created.id, sessionId, userId: session.createdBy },
          'Bookmark created via MCP',
        );

        broadcastToApp({ type: 'bookmark-created', sessionId, bookmarkId: created.id });

        // `create` returns the server-internal BookmarkRecord (wire summary
        // + userId + sourceSessionId); strip both before crossing the wire
        // (see packages/shared/src/types/bookmark.ts's wire-shape JSDoc).
        const { userId: _userId, sourceSessionId: _sourceSessionId, ...bookmark } = created;
        return textResult(bookmark);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, sessionId }, 'create_bookmark failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Tool: delete_bookmark ----------

  // Ninth session-claiming tool (checkCallerOwnsSession), alongside
  // send_session_message, delegate_to_worktree, remove_worktree,
  // create_conditional_wakeup, run_process, create_html_artifact,
  // delete_html_artifact, and create_bookmark. No mechanical registry
  // enumerates these tools; this comment is the convention-only marker.
  mcpServer.tool(
    'delete_bookmark',
    'Permanently delete a previously registered bookmark.',
    {
      bookmarkId: z.string().describe('The id of the bookmark to delete, as returned by create_bookmark.'),
      sessionId: z.string().describe(
        "The calling session's ID, used to resolve that session's owner (session.createdBy) for the ownership " +
          'check. Use your own AGENT_CONSOLE_SESSION_ID environment variable.',
      ),
    },
    async ({ bookmarkId, sessionId }) => {
      try {
        // Resolve the calling session. Ownership comparison below MUST
        // derive from session.createdBy, NEVER from getMcpCallerIdentity()
        // -- same layering as create_bookmark above: getMcpCallerIdentity()
        // is used ONLY for checkCallerOwnsSession.
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          return errorResult(`Session not found: ${sessionId}`);
        }
        if (!session.createdBy) {
          return errorResult(
            `Session ${sessionId} has no createdBy; deleting a bookmark from an ownerless (legacy) session is not possible`,
          );
        }

        const authError = checkCallerOwnsSession(
          getMcpCallerIdentity(),
          { sessionId, createdBy: session.createdBy },
          mcpAuthMode,
          { toolName: 'delete_bookmark' },
        );
        if (authError) return errorResult(authError.error);

        const bookmark = await bookmarkRepository.findById(bookmarkId);
        if (!bookmark) {
          return errorResult(`Bookmark not found: ${bookmarkId}`);
        }
        if (bookmark.userId !== session.createdBy) {
          return errorResult(
            `You do not own this bookmark (${bookmarkId}); only the owner can delete it`,
          );
        }

        const deleted = await bookmarkRepository.delete(bookmarkId);
        if (!deleted) {
          // Deleted between the existence check and delete (race); idempotent-style not-found, matching the REST route.
          return errorResult(`Bookmark not found: ${bookmarkId}`);
        }

        logger.info({ bookmarkId, sessionId, userId: session.createdBy }, 'Bookmark deleted via MCP');

        // Same rationale as delete_html_artifact: the trigger's sessionId
        // names the OWNING session (resolved from the record), not the
        // deleting call's own sessionId param -- see ArtifactRecord's doc
        // comment for the full explanation of why these diverge.
        broadcastToApp({ type: 'bookmark-deleted', sessionId: bookmark.sourceSessionId ?? sessionId, bookmarkId });

        return textResult({ deleted: true, bookmarkId });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error({ err, bookmarkId, sessionId }, 'delete_bookmark failed');
        return errorResult(message);
      }
    },
  );

  // ---------- Hono app ----------

  const mcpApp = new Hono();
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });

  // Connect transport once eagerly. The Promise is shared across all requests
  // so concurrent arrivals await the same connection rather than racing.
  const connectingPromise: Promise<void> = mcpServer.connect(transport);

  // Transport-level authN gate (Ruling 1): runs for EVERY
  // request to `/mcp` before the dispatch handler below -- including
  // `initialize` and `tools/list`, not just `tools/call` -- because MCP
  // tools are JSON-RPC methods dispatched INSIDE `transport.handleRequest`,
  // not separate Hono routes. Registering this once here is what
  // structurally guarantees a newly-registered `mcpServer.tool(...)` call
  // above is covered with zero per-tool action: there is exactly one place
  // in this file where a request reaches a tool body, and this middleware
  // sits in front of it. This answers "is this caller anyone at all?"
  // (authentication); the existing `checkCallerOwnsSession` call sites in
  // the 6 tools above still separately answer "does this caller own the
  // claimed session?" (authorization) and are unchanged by this gate.
  mcpApp.use('/mcp', createMcpAuthMiddleware({ mcpTokenRegistry, mcpAuthMode }));

  mcpApp.all('/mcp', async (c) => {
    await connectingPromise;
    // Cast required: @hono/mcp depends on its own Hono version (@jsr/hono__hono)
    // which has a slightly different Context type than the project's hono package.
    // The runtime Context objects are fully compatible; only the TypeScript types differ.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await transport.handleRequest(c as any);
  });

  return mcpApp;
}
