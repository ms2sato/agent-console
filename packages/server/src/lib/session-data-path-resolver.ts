/**
 * SessionDataPathResolver - Centralizes session data path resolution.
 *
 * Encapsulates the repository-scoped vs quick-session path branching
 * so callers never need to handle the conditional logic themselves.
 *
 * Path structure:
 *   Worktree sessions: ~/.agent-console/repositories/{org}/{repo}/[messages|memos|outputs]/
 *   Quick sessions:    ~/.agent-console/_quick/[messages|memos|outputs]/
 */

import * as path from 'path';
import { getConfigDir, getRepositoriesDir } from './config.js';

export class SessionDataPathResolver {
  constructor(private readonly repositoryName?: string) {}

  /**
   * Get the repository name used for path resolution.
   * Needed for serializable job payloads that cannot accept a resolver instance.
   */
  getRepositoryName(): string | undefined {
    return this.repositoryName;
  }

  /** Base directory for session data (repository-scoped or quick session) */
  private getBaseDir(): string {
    if (this.repositoryName) {
      return path.join(getRepositoriesDir(), this.repositoryName);
    }
    return path.join(getConfigDir(), '_quick');
  }

  getMessagesDir(): string {
    return path.join(this.getBaseDir(), 'messages');
  }

  getMemosDir(): string {
    return path.join(this.getBaseDir(), 'memos');
  }

  getMemosPath(sessionId: string): string {
    return path.join(this.getMemosDir(), `${sessionId}.md`);
  }

  getOutputsDir(): string {
    return path.join(this.getBaseDir(), 'outputs');
  }

  getOutputFilePath(sessionId: string, workerId: string): string {
    return path.join(this.getOutputsDir(), sessionId, `${workerId}.log`);
  }
}
