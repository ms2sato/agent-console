/**
 * UserMode - Abstraction for user authentication and PTY spawning.
 *
 * Encapsulates all mode-dependent behavior behind a single interface:
 * - Authentication (who is the current user?)
 * - Login (validate credentials)
 * - PTY spawning (how to start a process as the user)
 *
 * The mode decision is made once at startup. All other code depends only
 * on the UserMode interface, so no mode-checking logic is scattered
 * throughout the codebase.
 */

import * as os from 'os';
import type { AuthUser } from '@agent-console/shared';
import type { PtyProvider, PtyInstance } from '../lib/pty-provider.js';
import { getCleanChildProcessEnv, getUnsetEnvPrefix } from './env-filter.js';

// ========== PtySpawnRequest (Discriminated Union) ==========

/**
 * Typed keys for AGENT_CONSOLE_* environment variables.
 * These provide the agent with context about its own identity
 * for self-delegation (e.g., MCP tools) and agent self-awareness.
 */
export interface AgentConsoleContext {
  baseUrl: string;
  sessionId: string;
  workerId: string;
  repositoryId?: string;
  parentSessionId?: string;
  parentWorkerId?: string;
}

interface PtySpawnRequestBase {
  username: string;
  cwd: string;
  additionalEnvVars: Record<string, string>;
  cols: number;
  rows: number;
}

export interface AgentPtySpawnRequest extends PtySpawnRequestBase {
  type: 'agent';
  command: string;
  agentConsoleContext: AgentConsoleContext;
}

export interface TerminalPtySpawnRequest extends PtySpawnRequestBase {
  type: 'terminal';
}

export type PtySpawnRequest = AgentPtySpawnRequest | TerminalPtySpawnRequest;

// ========== LoginResult ==========

export interface LoginResult {
  user: AuthUser;
  token: string;
}

// ========== UserMode Interface ==========

export interface UserMode {
  authenticate(resolveToken: () => string | undefined): AuthUser | null;
  login(username: string, password: string): Promise<LoginResult | null>;
  spawnPty(request: PtySpawnRequest): PtyInstance;
}

// ========== SingleUserMode ==========

/**
 * Null Object implementation for single-user mode (AUTH_MODE=none).
 *
 * - authenticate(): Always returns the server process user (ignores token)
 * - login(): Always returns the server process user (no credential validation)
 * - spawnPty(): Direct spawn with env vars passed via process env option
 */
export class SingleUserMode implements UserMode {
  private ptyProvider: PtyProvider;

  constructor(ptyProvider: PtyProvider) {
    this.ptyProvider = ptyProvider;
  }

  authenticate(_resolveToken: () => string | undefined): AuthUser {
    return {
      username: os.userInfo().username,
      homeDir: os.homedir(),
    };
  }

  async login(_username: string, _password: string): Promise<LoginResult> {
    const user: AuthUser = {
      username: os.userInfo().username,
      homeDir: os.homedir(),
    };
    return { user, token: '' };
  }

  spawnPty(request: PtySpawnRequest): PtyInstance {
    const baseEnv = getCleanChildProcessEnv();

    switch (request.type) {
      case 'agent':
        return this.spawnAgentPty(request, baseEnv);
      case 'terminal':
        return this.spawnTerminalPty(request, baseEnv);
    }
  }

  private spawnAgentPty(
    request: AgentPtySpawnRequest,
    baseEnv: Record<string, string>,
  ): PtyInstance {
    // Convert AgentConsoleContext to AGENT_CONSOLE_* env vars
    const agentConsoleEnv: Record<string, string> = {
      AGENT_CONSOLE_BASE_URL: request.agentConsoleContext.baseUrl,
      AGENT_CONSOLE_SESSION_ID: request.agentConsoleContext.sessionId,
      AGENT_CONSOLE_WORKER_ID: request.agentConsoleContext.workerId,
    };
    if (request.agentConsoleContext.repositoryId) {
      agentConsoleEnv.AGENT_CONSOLE_REPOSITORY_ID = request.agentConsoleContext.repositoryId;
    }
    if (request.agentConsoleContext.parentSessionId) {
      agentConsoleEnv.AGENT_CONSOLE_PARENT_SESSION_ID = request.agentConsoleContext.parentSessionId;
    }
    if (request.agentConsoleContext.parentWorkerId) {
      agentConsoleEnv.AGENT_CONSOLE_PARENT_WORKER_ID = request.agentConsoleContext.parentWorkerId;
    }

    // Security: agentConsoleEnv is spread LAST so AGENT_CONSOLE_* vars
    // cannot be spoofed by repository-level config or agent command templates
    const processEnv = {
      ...baseEnv,
      ...request.additionalEnvVars,
      ...agentConsoleEnv,
    };

    const unsetPrefix = getUnsetEnvPrefix();
    return this.ptyProvider.spawn('sh', ['-c', unsetPrefix + request.command], {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: processEnv,
    });
  }

  private spawnTerminalPty(
    request: TerminalPtySpawnRequest,
    baseEnv: Record<string, string>,
  ): PtyInstance {
    const processEnv = {
      ...baseEnv,
      ...request.additionalEnvVars,
    };

    const unsetPrefix = getUnsetEnvPrefix();
    // Use $SHELL (shell variable resolved at PTY runtime, not process.env.SHELL at Node.js time).
    // In SingleUserMode they are equivalent since the child inherits the server's env.
    // In MultiUserMode, the login shell sets $SHELL to the target user's shell.
    return this.ptyProvider.spawn('sh', ['-c', `${unsetPrefix}exec $SHELL -l`], {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: processEnv,
    });
  }
}
