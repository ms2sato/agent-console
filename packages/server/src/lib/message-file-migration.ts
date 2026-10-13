/**
 * Startup sweep that renames legacy inter-session message files from the
 * `.json` extension to the current one. Message content is free-form text, so
 * the old extension misled JSON tooling. The sweep is best-effort and
 * idempotent: only names matching the writer's own grammar are touched, so a
 * converted file never matches again.
 *
 * Readers never discover message files by extension (they receive the absolute
 * path in the delivery notification), so a file this sweep skips stays readable.
 * Message files are created by the server process, so no elevation is needed.
 */

import * as path from 'path';
import { readdir, rename, lstat } from 'fs/promises';
import type { Dirent } from 'fs';
import { createLogger } from './logger.js';
import { MESSAGE_FILE_EXTENSION } from '../services/inter-session-message-service.js';

const logger = createLogger('message-file-migration');

const LEGACY_EXTENSION = '.json';

// Writer grammar: `${timestamp}-${fromSessionId}-${8 hex}`, where the session
// id is whatever `validateId` accepts.
const LEGACY_MESSAGE_FILE = /^\d+-[A-Za-z0-9._-]+-[a-f0-9]{8}\.json$/;

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readDirents(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/** `_quick`, `repositories/<a>` and `repositories/<a>/<b>`: every session-data base dir shape. */
async function listSessionDataBaseDirs(configDir: string): Promise<string[]> {
  const bases = [path.join(configDir, '_quick')];
  const repositoriesDir = path.join(configDir, 'repositories');
  for (const entry of await readDirents(repositoriesDir)) {
    if (!entry.isDirectory()) continue;
    const aDir = path.join(repositoriesDir, entry.name);
    bases.push(aDir);
    for (const sub of await readDirents(aDir)) {
      if (!sub.isDirectory()) continue;
      bases.push(path.join(aDir, sub.name));
    }
  }
  return bases;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

export async function renameLegacyMessageFiles(
  configDir: string,
): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0;
  let skipped = 0;

  for (const base of await listSessionDataBaseDirs(configDir)) {
    const messagesDir = path.join(base, 'messages');
    for (const sessionEntry of await readDirents(messagesDir)) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(messagesDir, sessionEntry.name);
      for (const workerEntry of await readDirents(sessionDir)) {
        if (!workerEntry.isDirectory()) continue;
        const workerDir = path.join(sessionDir, workerEntry.name);
        for (const file of await readDirents(workerDir)) {
          if (!file.isFile() || !LEGACY_MESSAGE_FILE.test(file.name)) continue;
          const from = path.join(workerDir, file.name);
          const to = path.join(
            workerDir,
            file.name.slice(0, -LEGACY_EXTENSION.length) + MESSAGE_FILE_EXTENSION,
          );
          try {
            if (await exists(to)) {
              skipped += 1;
              logger.warn({ from, to }, 'Legacy message file not renamed: target already exists');
              continue;
            }
            await rename(from, to);
            renamed += 1;
          } catch (err) {
            if (isEnoent(err)) continue;
            logger.warn({ err, from }, 'Legacy message file rename failed; continuing');
          }
        }
      }
    }
  }

  if (renamed + skipped > 0) {
    logger.info({ renamed, skipped }, 'Renamed legacy inter-session message files');
  } else {
    logger.debug({ renamed, skipped }, 'No legacy inter-session message files to rename');
  }
  return { renamed, skipped };
}
