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

import { getSessionManager } from '../services/session-manager.js';
import { getRepositoryManager } from '../services/repository-manager.js';
import { worktreeService } from '../services/worktree-service.js';
import { getAgentManager, CLAUDE_CODE_AGENT_ID } from '../services/agent-manager.js';
import { suggestSessionMetadata } from '../services/session-metadata-suggester.js';
import { fetchRemote, getRemoteUrl, GitError } from '../lib/git.js';
import { createLogger } from '../lib/logger.js';
import type { Session, AgentActivityState } from '@agent-console/shared';

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
  workers: Array<{
    id: string;
    type: 'agent' | 'terminal' | 'git-diff';
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
  status: 'active' | 'inactive';
  workers: Array<{
    id: string;
    type: 'agent' | 'terminal' | 'git-diff';
    activityState: AgentActivityState;
  }>;
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
 * Map a public Session to the worker info format used by MCP tool responses.
 */
function mapWorkers(session: Session): SessionStatusResult['workers'] {
  const sessionManager = getSessionManager();
  return session.workers.map((w) => ({
    id: w.id,
    type: w.type,
    activityState:
      w.type === 'agent'
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

interface AgentListItem {
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

mcpServer.tool(
  'list_agents',
  'List all registered agents in AgentConsole. Returns agent IDs, names, descriptions, and capabilities. ' +
    'Use this to discover available agents before calling delegate_to_worktree.',
  {},
  async () => {
    try {
      const agentManager = await getAgentManager();
      const agents = agentManager.getAllAgents();

      const result: AgentListItem[] = agents.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        isBuiltIn: a.isBuiltIn,
        capabilities: a.capabilities,
      }));

      return textResult({ agents: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err }, 'list_agents failed');
      return errorResult(message);
    }
  },
);

// ---------- Tool: list_repositories ----------

interface RepositoryListItem {
  id: string;
  name: string;
  remoteUrl?: string;
  description?: string;
}

mcpServer.tool(
  'list_repositories',
  'List all registered repositories in AgentConsole. Returns repository IDs, names, remote URLs, and brief descriptions. ' +
    'Use this to discover available repositories before calling delegate_to_worktree with a specific repositoryId.',
  {},
  async () => {
    try {
      const repositoryManager = getRepositoryManager();
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

// ---------- Tool: list_sessions ----------

mcpServer.tool(
  'list_sessions',
  'List all active sessions in AgentConsole. Returns session IDs, types, titles, and worker activity states.',
  {},
  async () => {
    try {
      const sessionManager = getSessionManager();
      const sessions = sessionManager.getAllSessions();

      const result: SessionListItem[] = sessions.map((s) => {
        const base: SessionListItem = {
          id: s.id,
          type: s.type,
          title: s.title,
          status: s.status,
          workers: mapWorkers(s),
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
      const sessionManager = getSessionManager();
      const session = sessionManager.getSession(sessionId);

      if (!session) {
        return errorResult(`Session not found: ${sessionId}`);
      }

      const result: SessionStatusResult = {
        sessionId: session.id,
        status: session.status,
        title: session.title,
        workers: mapWorkers(session),
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

// ---------- Tool: send_message_to_session ----------

mcpServer.tool(
  'send_message_to_session',
  'Send a follow-up message to a worker in a session. The worker must have an active PTY.',
  {
    sessionId: z.string().describe('The session ID'),
    workerId: z.string().describe('The worker ID to send the message to'),
    message: z.string().describe('The message content to send'),
  },
  async ({ sessionId, workerId, message }) => {
    try {
      const sessionManager = getSessionManager();
      const result = sessionManager.sendMessage(sessionId, null, workerId, message);

      if (!result) {
        return errorResult(
          'Failed to send message. The session, worker, or PTY may not be available.',
        );
      }

      return textResult({ success: true });
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, sessionId, workerId }, 'send_message_to_session failed');
      return errorResult(errMessage);
    }
  },
);

// ---------- Tool: delegate_to_worktree ----------

mcpServer.tool(
  'delegate_to_worktree',
  'Create a new worktree, start a session with an agent, and send a prompt. ' +
    'Use this to delegate work to a new agent running in an isolated worktree. ' +
    'Note: once started, the worktree and session persist on the server even if the MCP client disconnects. ' +
    'To delegate to a repository other than your own, use list_repositories to discover available repositories.',
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
      .describe(`Agent to use (defaults to ${CLAUDE_CODE_AGENT_ID})`),
    title: z.string().optional().describe('Human-readable session title'),
    useRemote: z
      .boolean()
      .optional()
      .describe('If true, branch from origin/<baseBranch> instead of local branch'),
  },
  async ({ repositoryId, prompt, baseBranch, branch, agentId, title, useRemote }) => {
    try {
      // Validate repository
      const repositoryManager = getRepositoryManager();
      const repo = repositoryManager.getRepository(repositoryId);
      if (!repo) {
        return errorResult(`Repository not found: ${repositoryId}`);
      }

      // Validate agent
      const selectedAgentId = agentId ?? CLAUDE_CODE_AGENT_ID;
      const agentManager = await getAgentManager();
      const agent = agentManager.getAgent(selectedAgentId);
      if (!agent) {
        return errorResult(`Agent not found: ${selectedAgentId}`);
      }

      // Determine branch name
      let effectiveBranch: string;
      let effectiveTitle = title;

      if (branch) {
        // Explicit branch name provided
        effectiveBranch = branch;
      } else {
        // Auto-generate branch name from prompt
        const suggestion = await suggestSessionMetadata({
          prompt: prompt.trim(),
          repositoryPath: repo.path,
          agent,
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
      let effectiveBaseBranch =
        baseBranch ??
        (await worktreeService.getDefaultBranch(repo.path)) ??
        'main';

      // Handle useRemote flag
      if (useRemote && effectiveBaseBranch) {
        try {
          await fetchRemote(effectiveBaseBranch, repo.path);
          effectiveBaseBranch = `origin/${effectiveBaseBranch}`;
        } catch (fetchErr) {
          logger.warn(
            {
              repositoryId,
              baseBranch: effectiveBaseBranch,
              err: fetchErr,
            },
            'Failed to fetch remote branch, falling back to local',
          );
          // Keep local baseBranch as-is
        }
      }

      // Create worktree
      const wtResult = await worktreeService.createWorktree(
        repo.path,
        effectiveBranch,
        repositoryId,
        effectiveBaseBranch,
      );

      if (wtResult.error) {
        return errorResult(`Worktree creation failed: ${wtResult.error}`);
      }

      // Track that worktree was created for rollback on subsequent failures
      const createdWorktreePath = wtResult.worktreePath;

      try {
        // Find created worktree info
        const worktrees = await worktreeService.listWorktrees(repo.path, repositoryId);
        const worktree = worktrees.find((wt) => wt.path === createdWorktreePath);

        if (!worktree) {
          throw new Error('Worktree was created but could not be found in the list');
        }

        // Execute setup command if configured
        if (repo.setupCommand && wtResult.index !== undefined) {
          await worktreeService.executeHookCommand(
            repo.setupCommand,
            createdWorktreePath,
            {
              worktreeNum: wtResult.index,
              branch: worktree.branch,
              repo: repo.name,
            },
          );
        }

        // Create session with agent worker
        const sessionManager = getSessionManager();
        const session = await sessionManager.createSession({
          type: 'worktree',
          repositoryId,
          worktreeId: worktree.branch,
          locationPath: worktree.path,
          agentId: selectedAgentId,
          initialPrompt: prompt,
          title: effectiveTitle,
        });

        // Re-check session still exists after async gap.
        // Session may have been deleted concurrently during createSession.
        const currentSession = sessionManager.getSession(session.id);
        if (!currentSession) {
          logger.warn(
            { sessionId: session.id, repositoryId },
            'Session deleted during delegate_to_worktree, rolling back worktree',
          );
          throw new Error('Session was deleted before delegation could complete');
        }

        // Find the agent worker ID from the created session
        const agentWorker = currentSession.workers.find((w) => w.type === 'agent');
        if (!agentWorker) {
          return errorResult('Session created but no agent worker was found');
        }

        const result: DelegateResult = {
          sessionId: session.id,
          workerId: agentWorker.id,
          worktreePath: worktree.path,
          branch: worktree.branch,
        };

        logger.info(
          { sessionId: session.id, branch: worktree.branch, repositoryId },
          'Worktree delegation completed via MCP',
        );

        return textResult(result);
      } catch (postWorktreeErr) {
        // Rollback: remove the worktree that was created before the failure
        logger.warn(
          { worktreePath: createdWorktreePath, err: postWorktreeErr },
          'Post-worktree step failed, rolling back worktree',
        );
        try {
          await worktreeService.removeWorktree(repo.path, createdWorktreePath, true);
        } catch (cleanupErr) {
          logger.warn(
            { worktreePath: createdWorktreePath, err: cleanupErr },
            'Failed to clean up worktree during rollback',
          );
        }
        throw postWorktreeErr;
      }
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

// ---------- Hono app ----------

const mcpApp = new Hono();
const transport = new StreamableHTTPTransport({ enableJsonResponse: true });

mcpApp.all('/mcp', async (c) => {
  if (!mcpServer.server.transport) {
    await mcpServer.connect(transport);
  }
  // Cast required: @hono/mcp depends on its own Hono version (@jsr/hono__hono)
  // which has a slightly different Context type than the project's hono package.
  // The runtime Context objects are fully compatible; only the TypeScript types differ.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await transport.handleRequest(c as any);
});

export { mcpApp };
