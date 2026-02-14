import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as v from 'valibot';
import type { AgentDefinition } from '@agent-console/shared';
import { AgentDefinitionSchema } from '@agent-console/shared';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('persistence-service');

// Config directory paths (lazy-evaluated to support env override)
const getRepositoriesFile = () => path.join(getConfigDir(), 'repositories.json');
const getSessionsFile = () => path.join(getConfigDir(), 'sessions.json');
const getAgentsFile = () => path.join(getConfigDir(), 'agents.json');

export interface PersistedRepository {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  setupCommand?: string | null;
  envVars?: string | null;
  description?: string | null;
}

// Base for all persisted workers
interface PersistedWorkerBase {
  id: string;
  name: string;
  createdAt: string;
}

export interface PersistedAgentWorker extends PersistedWorkerBase {
  type: 'agent';
  agentId: string;
  pid: number | null;  // PTY process ID (null when not yet activated after server restart)
}

export interface PersistedTerminalWorker extends PersistedWorkerBase {
  type: 'terminal';
  pid: number | null;  // PTY process ID (null when not yet activated after server restart)
}

export interface PersistedGitDiffWorker extends PersistedWorkerBase {
  type: 'git-diff';
  baseCommit: string;  // No pid - runs in server process
}

export type PersistedWorker = PersistedAgentWorker | PersistedTerminalWorker | PersistedGitDiffWorker;

interface PersistedSessionBase {
  id: string;
  locationPath: string;
  /**
   * Server process ID that owns this session.
   * - undefined: no update (when used in Partial<PersistedSession>)
   * - null: explicitly cleared (paused session, not owned by any server)
   * - number: owned by the server with this PID
   */
  serverPid?: number | null;
  createdAt: string;
  workers: PersistedWorker[];
  initialPrompt?: string;
  title?: string;
}

export interface PersistedWorktreeSession extends PersistedSessionBase {
  type: 'worktree';
  repositoryId: string;
  worktreeId: string;
}

export interface PersistedQuickSession extends PersistedSessionBase {
  type: 'quick';
}

export type PersistedSession = PersistedWorktreeSession | PersistedQuickSession;

interface OldPersistedSession {
  id: string;
  worktreePath: string;
  repositoryId: string;
  pid: number;
  serverPid: number;
  createdAt: string;
}

function isOldFormat(session: unknown): session is OldPersistedSession {
  return typeof session === 'object' && session !== null &&
    (!('type' in session) || !('workers' in session));
}

function migrateSession(old: OldPersistedSession): PersistedSession {
  const isQuick = old.repositoryId === 'default';

  const workers: PersistedWorker[] = [{
    id: `${old.id}-agent`,
    type: 'agent',
    name: 'Claude',
    agentId: 'claude-code-builtin',
    pid: old.pid,
    createdAt: old.createdAt,
  }];

  if (isQuick) {
    return {
      id: old.id,
      type: 'quick',
      locationPath: old.worktreePath,
      serverPid: old.serverPid,
      createdAt: old.createdAt,
      workers,
    };
  } else {
    return {
      id: old.id,
      type: 'worktree',
      locationPath: old.worktreePath,
      repositoryId: old.repositoryId,
      worktreeId: old.worktreePath,  // Use path as worktreeId for migration
      serverPid: old.serverPid,
      createdAt: old.createdAt,
      workers,
    };
  }
}

async function ensureConfigDir(): Promise<void> {
  const configDir = getConfigDir();
  await fsPromises.mkdir(configDir, { recursive: true });
}

/**
 * Write data to a file atomically using a unique temporary file.
 * Uses PID + random bytes to ensure uniqueness across concurrent writes.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  // Use unique temp file per write operation to prevent race conditions
  const uniqueSuffix = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

  try {
    await fsPromises.writeFile(tempPath, data, 'utf-8');
    await fsPromises.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

async function safeRead<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ err: error, filePath }, 'Failed to read file');
    }
  }
  return defaultValue;
}

export class PersistenceService {
  private initPromise: Promise<void>;

  constructor() {
    this.initPromise = ensureConfigDir();
  }

  async loadRepositories(): Promise<PersistedRepository[]> {
    await this.initPromise;
    return safeRead<PersistedRepository[]>(getRepositoriesFile(), []);
  }

  async saveRepositories(repositories: PersistedRepository[]): Promise<void> {
    await this.initPromise;
    await atomicWrite(getRepositoriesFile(), JSON.stringify(repositories, null, 2));
  }

  async loadSessions(): Promise<PersistedSession[]> {
    await this.initPromise;
    const raw = await safeRead<unknown[]>(getSessionsFile(), []);

    // Migrate old format if needed
    return raw.map(session => {
      if (isOldFormat(session)) {
        logger.info({ sessionId: session.id }, 'Migrating old session format');
        return migrateSession(session);
      }
      return session as PersistedSession;
    });
  }

  async saveSessions(sessions: PersistedSession[]): Promise<void> {
    await this.initPromise;
    await atomicWrite(getSessionsFile(), JSON.stringify(sessions, null, 2));
  }

  // Get session metadata by ID (for reconnection)
  async getSessionMetadata(sessionId: string): Promise<PersistedSession | undefined> {
    const sessions = await this.loadSessions();
    return sessions.find(s => s.id === sessionId);
  }

  // Remove session from persisted storage
  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.loadSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);
    await this.saveSessions(filtered);
  }

  // Clear all sessions (used after cleanup)
  async clearSessions(): Promise<void> {
    await this.saveSessions([]);
  }

  async loadAgents(): Promise<AgentDefinition[]> {
    await this.initPromise;
    const raw = await safeRead<unknown[]>(getAgentsFile(), []);
    const validAgents: AgentDefinition[] = [];

    for (const item of raw) {
      const result = v.safeParse(AgentDefinitionSchema, item);
      if (result.success) {
        validAgents.push(result.output as AgentDefinition);
      } else {
        const agentId = (item as { id?: string })?.id ?? 'unknown';
        logger.warn({ agentId, issues: v.flatten(result.issues) }, 'Skipping invalid persisted agent');
      }
    }

    return validAgents;
  }

  async saveAgents(agents: AgentDefinition[]): Promise<void> {
    await this.initPromise;
    await atomicWrite(getAgentsFile(), JSON.stringify(agents, null, 2));
  }

  async getAgent(agentId: string): Promise<AgentDefinition | undefined> {
    const agents = await this.loadAgents();
    return agents.find(a => a.id === agentId);
  }

  async removeAgent(agentId: string): Promise<boolean> {
    const agents = await this.loadAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent || agent.isBuiltIn) {
      return false; // Cannot remove built-in agents
    }
    const filtered = agents.filter(a => a.id !== agentId);
    await this.saveAgents(filtered);
    return true;
  }
}

// Singleton instance
export const persistenceService = new PersistenceService();
