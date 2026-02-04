import * as fs from 'fs';
import * as crypto from 'crypto';
import type { PersistedSession } from '../services/persistence-service.js';
import type { SessionRepository } from './session-repository.js';

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

/**
 * Safely read and parse JSON from a file.
 * Returns the default value if the file doesn't exist or parsing fails.
 */
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

/**
 * JSON file-based implementation of SessionRepository.
 * Stores sessions as a JSON array in a single file.
 */
export class JsonSessionRepository implements SessionRepository {
  constructor(private readonly filePath: string) {}

  async findAll(): Promise<PersistedSession[]> {
    return safeRead<PersistedSession[]>(this.filePath, []);
  }

  async findById(id: string): Promise<PersistedSession | null> {
    const sessions = await this.findAll();
    return sessions.find((s) => s.id === id) ?? null;
  }

  async findByServerPid(pid: number): Promise<PersistedSession[]> {
    const sessions = await this.findAll();
    return sessions.filter((s) => s.serverPid === pid);
  }

  async save(session: PersistedSession): Promise<void> {
    const sessions = await this.findAll();
    const index = sessions.findIndex((s) => s.id === session.id);

    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.push(session);
    }

    atomicWrite(this.filePath, JSON.stringify(sessions, null, 2));
  }

  async saveAll(sessions: PersistedSession[]): Promise<void> {
    atomicWrite(this.filePath, JSON.stringify(sessions, null, 2));
  }

  async delete(id: string): Promise<void> {
    const sessions = await this.findAll();
    const filtered = sessions.filter((s) => s.id !== id);
    atomicWrite(this.filePath, JSON.stringify(filtered, null, 2));
  }

  async update(id: string, updates: Partial<PersistedSession>): Promise<boolean> {
    const sessions = await this.findAll();
    const index = sessions.findIndex((s) => s.id === id);

    if (index < 0) {
      return false;
    }

    // Merge updates with existing session while preserving the discriminated union type
    const existing = sessions[index];
    if (existing.type === 'worktree') {
      sessions[index] = { ...existing, ...updates } as typeof existing;
    } else {
      sessions[index] = { ...existing, ...updates } as typeof existing;
    }
    atomicWrite(this.filePath, JSON.stringify(sessions, null, 2));
    return true;
  }
}
