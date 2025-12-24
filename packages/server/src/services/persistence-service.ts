import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as v from 'valibot';
import type { AgentDefinition } from '@agent-console/shared';
import { AgentDefinitionSchema } from '@agent-console/shared';
import { getConfigDir } from '../lib/config.js';

// Config directory paths (lazy-evaluated to support env override)
const getRepositoriesFile = () => path.join(getConfigDir(), 'repositories.json');
const getSessionsFile = () => path.join(getConfigDir(), 'sessions.json');
const getAgentsFile = () => path.join(getConfigDir(), 'agents.json');

export interface PersistedRepository {
  id: string;
  name: string;
  path: string;
  registeredAt: string;
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
  /** Server process ID that owns this session (undefined for orphaned sessions) */
  serverPid?: number;
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

function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log(`Created config directory: ${configDir}`);
  }
}

/**
 * Write data to a file atomically using a unique temporary file.
 * Uses PID + random bytes to ensure uniqueness across concurrent writes.
 */
function atomicWrite(filePath: string, data: string): void {
  // Use unique temp file per write operation to prevent race conditions
  const uniqueSuffix = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

  try {
    fs.writeFileSync(tempPath, data, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

function safeRead<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`Failed to read ${filePath}:`, error);
  }
  return defaultValue;
}

export class PersistenceService {
  constructor() {
    ensureConfigDir();
  }

  loadRepositories(): PersistedRepository[] {
    return safeRead<PersistedRepository[]>(getRepositoriesFile(), []);
  }

  saveRepositories(repositories: PersistedRepository[]): void {
    atomicWrite(getRepositoriesFile(), JSON.stringify(repositories, null, 2));
  }

  loadSessions(): PersistedSession[] {
    const raw = safeRead<unknown[]>(getSessionsFile(), []);

    // Migrate old format if needed
    return raw.map(session => {
      if (isOldFormat(session)) {
        console.log(`Migrating old session format: ${session.id}`);
        return migrateSession(session);
      }
      return session as PersistedSession;
    });
  }

  saveSessions(sessions: PersistedSession[]): void {
    atomicWrite(getSessionsFile(), JSON.stringify(sessions, null, 2));
  }

  // Get session metadata by ID (for reconnection)
  getSessionMetadata(sessionId: string): PersistedSession | undefined {
    const sessions = this.loadSessions();
    return sessions.find(s => s.id === sessionId);
  }

  // Remove session from persisted storage
  removeSession(sessionId: string): void {
    const sessions = this.loadSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);
    this.saveSessions(filtered);
  }

  // Clear all sessions (used after cleanup)
  clearSessions(): void {
    this.saveSessions([]);
  }

  loadAgents(): AgentDefinition[] {
    const raw = safeRead<unknown[]>(getAgentsFile(), []);
    const validAgents: AgentDefinition[] = [];

    for (const item of raw) {
      const result = v.safeParse(AgentDefinitionSchema, item);
      if (result.success) {
        validAgents.push(result.output as AgentDefinition);
      } else {
        const agentId = (item as { id?: string })?.id ?? 'unknown';
        console.warn(`Skipping invalid persisted agent (id: ${agentId}):`, v.flatten(result.issues));
      }
    }

    return validAgents;
  }

  saveAgents(agents: AgentDefinition[]): void {
    atomicWrite(getAgentsFile(), JSON.stringify(agents, null, 2));
  }

  getAgent(agentId: string): AgentDefinition | undefined {
    const agents = this.loadAgents();
    return agents.find(a => a.id === agentId);
  }

  removeAgent(agentId: string): boolean {
    const agents = this.loadAgents();
    const agent = agents.find(a => a.id === agentId);
    if (!agent || agent.isBuiltIn) {
      return false; // Cannot remove built-in agents
    }
    const filtered = agents.filter(a => a.id !== agentId);
    this.saveAgents(filtered);
    return true;
  }
}

// Singleton instance
export const persistenceService = new PersistenceService();
