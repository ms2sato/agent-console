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
import type { UserRepository } from '../repositories/user-repository.js';
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
 * - authenticate(): Always returns the cached server process user (ignores token)
 * - login(): Always returns the cached server process user (no credential validation)
 * - spawnPty(): Direct spawn with env vars passed via process env option
 *
 * On initialization, upserts a user record for the server process user
 * and caches the resulting AuthUser (which includes a stable UUID).
 */
export class SingleUserMode implements UserMode {
  private ptyProvider: PtyProvider;
  private cachedUser: AuthUser;

  /**
   * Use SingleUserMode.create() factory method for production.
   * Direct constructor is available for tests that need to inject a pre-built AuthUser.
   */
  constructor(ptyProvider: PtyProvider, cachedUser: AuthUser) {
    this.ptyProvider = ptyProvider;
    this.cachedUser = cachedUser;
  }

  /**
   * Factory method that upserts the server process user on init.
   * This ensures a stable UUID exists in the users table.
   */
  static async create(ptyProvider: PtyProvider, userRepository: UserRepository): Promise<SingleUserMode> {
    const userInfo = os.userInfo();
    const cachedUser = await userRepository.upsertByOsUid(
      userInfo.uid,
      userInfo.username,
      os.homedir(),
    );
    return new SingleUserMode(ptyProvider, cachedUser);
  }

  authenticate(_resolveToken: () => string | undefined): AuthUser {
    return this.cachedUser;
  }

  async login(_username: string, _password: string): Promise<LoginResult> {
    return { user: this.cachedUser, token: '' };
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
    const ctx = request.agentConsoleContext;

    // Convert AgentConsoleContext to AGENT_CONSOLE_* env vars.
    // Optional fields are spread conditionally to avoid `undefined` values in the env.
    const agentConsoleEnv: Record<string, string> = {
      AGENT_CONSOLE_BASE_URL: ctx.baseUrl,
      AGENT_CONSOLE_SESSION_ID: ctx.sessionId,
      AGENT_CONSOLE_WORKER_ID: ctx.workerId,
      ...(ctx.repositoryId && { AGENT_CONSOLE_REPOSITORY_ID: ctx.repositoryId }),
      ...(ctx.parentSessionId && { AGENT_CONSOLE_PARENT_SESSION_ID: ctx.parentSessionId }),
      ...(ctx.parentWorkerId && { AGENT_CONSOLE_PARENT_WORKER_ID: ctx.parentWorkerId }),
    };

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
