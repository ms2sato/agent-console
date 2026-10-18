import { isAbsolute } from 'node:path';

/**
 * Lexical guard for a file path received from a client and meant to be
 * resolved against a working directory: rejects absolute paths (including
 * Windows drive-absolute), any path containing `..` (as a substring, so a
 * file named `a..b` is rejected too -- accepted, rare), and any path
 * containing a NUL byte.
 *
 * Lexical only: it does not stop a symlink inside the directory from pointing
 * outside it. A caller that follows symlinks must also confine the resolved
 * path (see `file-viewer-service.ts`).
 */
export function isValidFilePath(filePath: string): boolean {
  if (isAbsolute(filePath)) return false;
  if (filePath.includes('..')) return false;
  if (filePath.includes('\0')) return false;
  return true;
}
