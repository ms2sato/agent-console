/**
 * SessionDataPathResolver — thin wrapper around a precomputed base directory.
 *
 * The base directory is always computed via `computeSessionDataBaseDir` in
 * `session-data-path.ts`. See `docs/design/session-data-path.md` for the spec.
 */
import * as path from 'path';

export class SessionDataPathResolver {
  constructor(private readonly baseDir: string) {}

  getMessagesDir(): string {
    return path.join(this.baseDir, 'messages');
  }

  getMemosDir(): string {
    return path.join(this.baseDir, 'memos');
  }

  getMemosPath(sessionId: string): string {
    return path.join(this.getMemosDir(), `${sessionId}.md`);
  }

  getOutputsDir(): string {
    return path.join(this.baseDir, 'outputs');
  }

  getOutputFilePath(sessionId: string, workerId: string): string {
    return path.join(this.getOutputsDir(), sessionId, `${workerId}.log`);
  }
}
