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
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { $ } from 'bun';
import { SignJWT, type JWTPayload } from 'jose';
import type { AuthUser } from '@agent-console/shared';
import type { PtyProvider, PtyInstance } from '../lib/pty-provider.js';
import type { UserRepository } from '../repositories/user-repository.js';
import { getCleanChildProcessEnv, getUnsetEnvPrefix } from './env-filter.js';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('user-mode');

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
  /** OS username of the user who owns this PTY process. Used by MultiUserMode for sudo. */
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

// ========== Shared Direct PTY Spawning ==========

/**
 * Spawn a PTY process directly (no sudo) with env vars passed via process env option.
 * Shared by SingleUserMode.spawnPty() and MultiUserMode.spawnDirectPty() (sudo-skip optimization).
 */
function spawnDirectPty(ptyProvider: PtyProvider, request: PtySpawnRequest): PtyInstance {
  const baseEnv = getCleanChildProcessEnv();

  switch (request.type) {
    case 'agent': {
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
      return ptyProvider.spawn('sh', ['-c', unsetPrefix + request.command], {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: processEnv,
      });
    }
    case 'terminal': {
      const processEnv = {
        ...baseEnv,
        ...request.additionalEnvVars,
      };

      const unsetPrefix = getUnsetEnvPrefix();
      // Use $SHELL (shell variable resolved at PTY runtime, not process.env.SHELL at Node.js time).
      // In SingleUserMode they are equivalent since the child inherits the server's env.
      // In MultiUserMode, the login shell sets $SHELL to the target user's shell.
      return ptyProvider.spawn('sh', ['-c', `${unsetPrefix}exec $SHELL -l`], {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: processEnv,
      });
    }
  }
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
    return spawnDirectPty(this.ptyProvider, request);
  }
}

// ========== JWT Token Payload ==========

interface JwtTokenPayload extends JWTPayload {
  /** users.id (UUID) */
  sub: string;
  /** OS username (for display, not as identifier) */
  username: string;
  /** Home directory path */
  home: string;
}

// ========== MultiUserMode ==========

/** JWT expiration time */
const JWT_EXPIRY = '7d';

/** JWT secret file name within AGENT_CONSOLE_HOME */
const JWT_SECRET_FILE = 'jwt-secret';

/**
 * Multi-user mode implementation (AUTH_MODE=multi-user).
 *
 * - authenticate(): Validates JWT from cookie, returns AuthUser or null
 * - login(): Validates OS credentials (macOS: dscl, Linux: pamtester), generates JWT
 * - spawnPty(): Spawns via sudo -u <user> -i, with sudo-skip optimization
 */
export class MultiUserMode implements UserMode {
  private ptyProvider: PtyProvider;
  private userRepository: UserRepository;
  private jwtSecret: Uint8Array;
  private serverProcessUsername: string;

  private constructor(
    ptyProvider: PtyProvider,
    userRepository: UserRepository,
    jwtSecret: Uint8Array,
  ) {
    this.ptyProvider = ptyProvider;
    this.userRepository = userRepository;
    this.jwtSecret = jwtSecret;
    this.serverProcessUsername = os.userInfo().username;
  }

  /**
   * Factory method that loads or generates the JWT secret.
   */
  static async create(ptyProvider: PtyProvider, userRepository: UserRepository): Promise<MultiUserMode> {
    const secretPath = path.join(getConfigDir(), JWT_SECRET_FILE);
    let jwtSecret: Uint8Array;

    try {
      const secretBuffer = await fs.readFile(secretPath);
      jwtSecret = new Uint8Array(secretBuffer);
      logger.info('Loaded existing JWT secret');
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — generate new secret
        jwtSecret = new Uint8Array(crypto.randomBytes(32));
        await fs.mkdir(path.dirname(secretPath), { recursive: true });
        await fs.writeFile(secretPath, Buffer.from(jwtSecret), { mode: 0o600 });
        logger.info('Generated new JWT secret');
      } else {
        // Permission error, corruption, etc. — fail loudly
        throw err;
      }
    }

    return new MultiUserMode(ptyProvider, userRepository, jwtSecret);
  }

  authenticate(resolveToken: () => string | undefined): AuthUser | null {
    const token = resolveToken();
    if (!token) return null;

    try {
      // Synchronous JWT validation using jose's sync API is not available.
      // Since authenticate() must be synchronous (middleware pattern),
      // we parse and verify the token manually using jose's compact format.
      // This is a workaround: we decode the payload and verify the signature sync.
      // For production, we use a cached validation approach.
      return this.verifyTokenSync(token);
    } catch (err) {
      logger.debug({ err }, 'JWT authentication failed');
      return null;
    }
  }

  async login(username: string, password: string): Promise<LoginResult | null> {
    // Validate OS credentials
    const isValid = await this.validateOsCredentials(username, password);
    if (!isValid) {
      logger.info({ username }, 'Login failed: invalid credentials');
      return null;
    }

    // Look up the user's home directory and OS UID
    const userInfo = await this.lookupOsUser(username);
    if (!userInfo) {
      logger.warn({ username }, 'Login failed: could not look up OS user info');
      return null;
    }

    // Upsert user in database
    const authUser = await this.userRepository.upsertByOsUid(
      userInfo.uid,
      username,
      userInfo.homeDir,
    );

    // Generate JWT
    const token = await new SignJWT({
      username: authUser.username,
      home: authUser.homeDir,
    } satisfies Omit<JwtTokenPayload, 'sub' | 'iat' | 'exp'>)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(authUser.id)
      .setIssuedAt()
      .setExpirationTime(JWT_EXPIRY)
      .sign(this.jwtSecret);

    logger.info({ username, userId: authUser.id }, 'Login successful');
    return { user: authUser, token };
  }

  spawnPty(request: PtySpawnRequest): PtyInstance {
    // Sudo skip optimization: when the authenticated user is the server process user,
    // fall back to direct spawning (no sudo needed)
    if (request.username === this.serverProcessUsername) {
      return spawnDirectPty(this.ptyProvider, request);
    }

    return this.spawnSudoPty(request);
  }

  // ========== Private: OS Authentication ==========

  private async validateOsCredentials(username: string, password: string): Promise<boolean> {
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        return await this.validateMacOs(username, password);
      } else if (platform === 'linux') {
        return await this.validateLinux(username, password);
      } else {
        logger.error({ platform }, 'Unsupported platform for OS authentication');
        return false;
      }
    } catch (err) {
      logger.error({ username, platform, err }, 'OS credential validation error');
      return false;
    }
  }

  private async validateMacOs(username: string, password: string): Promise<boolean> {
    try {
      // Use Bun.spawn with an args array (no shell) to prevent shell injection.
      // dscl requires the password as a command-line argument (no stdin option).
      // This avoids shell metacharacter issues even if the password contains special chars.
      const proc = Bun.spawn(['dscl', '.', '-authonly', username, password], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  private async validateLinux(username: string, password: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(['pamtester', 'login', username, 'authenticate'], {
        stdin: 'pipe',
      });
      proc.stdin.write(password + '\n');
      proc.stdin.end();
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  // ========== Private: OS User Lookup ==========

  private async lookupOsUser(username: string): Promise<{ uid: number; homeDir: string } | null> {
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        return await this.lookupMacOsUser(username);
      } else if (platform === 'linux') {
        return await this.lookupLinuxUser(username);
      }
      return null;
    } catch (err) {
      logger.error({ username, platform, err }, 'Failed to look up OS user');
      return null;
    }
  }

  private async lookupMacOsUser(username: string): Promise<{ uid: number; homeDir: string } | null> {
    try {
      const uidResult = await $`dscl . -read /Users/${username} UniqueID`.quiet().text();
      const homeResult = await $`dscl . -read /Users/${username} NFSHomeDirectory`.quiet().text();

      const uidMatch = uidResult.match(/UniqueID:\s*(\d+)/);
      const homeMatch = homeResult.match(/NFSHomeDirectory:\s*(.+)/);

      if (!uidMatch || !homeMatch) return null;

      return {
        uid: parseInt(uidMatch[1], 10),
        homeDir: homeMatch[1].trim(),
      };
    } catch {
      return null;
    }
  }

  private async lookupLinuxUser(username: string): Promise<{ uid: number; homeDir: string } | null> {
    try {
      const result = await $`id -u ${username}`.quiet().text();
      const uid = parseInt(result.trim(), 10);
      if (isNaN(uid)) return null;

      const homeResult = await $`getent passwd ${username}`.quiet().text();
      const fields = homeResult.trim().split(':');
      // passwd format: username:x:uid:gid:gecos:home:shell
      if (fields.length < 6) return null;

      return { uid, homeDir: fields[5] };
    } catch {
      return null;
    }
  }

  // ========== Private: JWT ==========

  /**
   * Synchronous JWT verification.
   * jose's jwtVerify is async, but authenticate() must be sync.
   * We manually decode and verify the token structure and expiration.
   * The actual signature verification is done synchronously using
   * the Web Crypto API's importKey + verify.
   */
  private verifyTokenSync(token: string): AuthUser | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      // Decode header
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (header.alg !== 'HS256') return null;

      // Verify signature using HMAC
      const hmac = crypto.createHmac('sha256', this.jwtSecret);
      hmac.update(`${parts[0]}.${parts[1]}`);
      const expectedSig = hmac.digest();
      const actualSig = Buffer.from(parts[2], 'base64url');

      if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

      // Decode payload
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as JwtTokenPayload;

      // Check expiration — tokens without exp claim are rejected
      if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

      // Validate required fields
      if (!payload.sub || !payload.username || !payload.home) return null;

      return {
        id: payload.sub,
        username: payload.username,
        homeDir: payload.home,
      };
    } catch {
      return null;
    }
  }

  // ========== Private: PTY Spawning ==========

  /**
   * Spawn PTY via sudo -u <user> -i.
   * Creates a full login shell as the target user.
   * Environment variables are embedded in the command since sudo -i
   * does not inherit the parent's process environment.
   */
  private spawnSudoPty(request: PtySpawnRequest): PtyInstance {
    const envExports = this.buildEnvExportString(request);

    let innerCommand: string;
    switch (request.type) {
      case 'agent': {
        const ctx = request.agentConsoleContext;
        const agentConsoleVars: Record<string, string> = {
          AGENT_CONSOLE_BASE_URL: ctx.baseUrl,
          AGENT_CONSOLE_SESSION_ID: ctx.sessionId,
          AGENT_CONSOLE_WORKER_ID: ctx.workerId,
          ...(ctx.repositoryId && { AGENT_CONSOLE_REPOSITORY_ID: ctx.repositoryId }),
          ...(ctx.parentSessionId && { AGENT_CONSOLE_PARENT_SESSION_ID: ctx.parentSessionId }),
          ...(ctx.parentWorkerId && { AGENT_CONSOLE_PARENT_WORKER_ID: ctx.parentWorkerId }),
        };
        const agentExports = this.buildExportString(agentConsoleVars);
        const allExports = [envExports, agentExports].filter(Boolean).join(' ');
        innerCommand = allExports
          ? `cd ${this.shellEscape(request.cwd)} && export ${allExports}; ${request.command}`
          : `cd ${this.shellEscape(request.cwd)} && ${request.command}`;
        break;
      }
      case 'terminal': {
        innerCommand = envExports
          ? `cd ${this.shellEscape(request.cwd)} && export ${envExports}; exec $SHELL -l`
          : `cd ${this.shellEscape(request.cwd)} && exec $SHELL -l`;
        break;
      }
    }

    return this.ptyProvider.spawn(
      'sudo',
      ['-u', request.username, '-i', 'sh', '-c', innerCommand],
      {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
      },
    );
  }

  /**
   * Build export string from additionalEnvVars (repository + template env vars).
   */
  private buildEnvExportString(request: PtySpawnRequest): string {
    return this.buildExportString(request.additionalEnvVars);
  }

  /**
   * Convert a Record<string, string> to a shell export string.
   * e.g., "KEY1=val1 KEY2=val2"
   *
   * Keys are validated against POSIX environment variable naming rules
   * to prevent shell injection via crafted key names.
   */
  private buildExportString(vars: Record<string, string>): string {
    return Object.entries(vars)
      .filter(([key]) => {
        const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
        if (!valid) {
          logger.warn({ key }, 'Skipping environment variable with invalid key name');
        }
        return valid;
      })
      .map(([key, value]) => `${key}=${this.shellEscape(value)}`)
      .join(' ');
  }

  /**
   * Escape a string for safe use in a single-quoted shell context.
   */
  private shellEscape(value: string): string {
    // Use single quotes, escaping any embedded single quotes
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
