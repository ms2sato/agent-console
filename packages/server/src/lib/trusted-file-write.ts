import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureTrustedDirChain, resolveAncestorContract } from './trusted-dir.js';

/**
 * Write `content` (a string as UTF-8, or raw bytes, byte for byte) to `filePath`, creating any missing
 * ancestor directory up to `trustedRoot` through the trusted-dir walker (no
 * explicit mode, so the files inherit the data root's contract). The write is
 * atomic: a temp file in the same directory, then a rename; a failed rename
 * removes the temp file. Single writer of this shape for session-data files
 * whose name the caller chooses (the paused-digest read-more file, the inbound
 * webhook delivery files).
 */
export async function writeFileInTrustedDir(
  trustedRoot: string,
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  await ensureTrustedDirChain(trustedRoot, path.dirname(filePath), resolveAncestorContract());
  const tmpPath = `${filePath}.tmp`;
  if (typeof content === 'string') {
    await fs.writeFile(tmpPath, content, 'utf-8');
  } else {
    await fs.writeFile(tmpPath, content);
  }
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
