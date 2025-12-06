import * as fs from 'fs';
import * as path from 'path';
import type { AgentDefinition } from '@agent-console/shared';
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

export interface PersistedSession {
  id: string;
  worktreePath: string;
  repositoryId: string;
  pid: number;
  serverPid: number;  // PID of the server that created this session
  createdAt: string;
}


function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log(`Created config directory: ${configDir}`);
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, data, 'utf-8');
  fs.renameSync(tempPath, filePath);
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

  // ========== Repositories ==========

  loadRepositories(): PersistedRepository[] {
    return safeRead<PersistedRepository[]>(getRepositoriesFile(), []);
  }

  saveRepositories(repositories: PersistedRepository[]): void {
    atomicWrite(getRepositoriesFile(), JSON.stringify(repositories, null, 2));
  }

  // ========== Sessions ==========

  loadSessions(): PersistedSession[] {
    return safeRead<PersistedSession[]>(getSessionsFile(), []);
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

  // ========== Agents ==========

  loadAgents(): AgentDefinition[] {
    return safeRead<AgentDefinition[]>(getAgentsFile(), []);
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
