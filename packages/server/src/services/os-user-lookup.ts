/**
 * OS user lookup helpers.
 *
 * Resolves an OS username to its UID and home directory using platform-native
 * tools (`dscl` on macOS, `id` + `getent` on Linux). Extracted from
 * `MultiUserMode` so the same logic is reusable from non-auth contexts (e.g.,
 * `SharedAccountRegistry` startup resolution) without going through a class.
 */

import * as os from 'os';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('os-user-lookup');

export interface OsUserInfo {
  uid: number;
  homeDir: string;
}

/**
 * Function shape for `lookupOsUser`. Exposed so consumers can inject a stub
 * in tests without monkey-patching `Bun.spawn`.
 */
export type LookupOsUserFn = (username: string) => Promise<OsUserInfo | null>;

/**
 * Look up the OS user (uid + home directory) for the given username.
 * Returns null when the user does not exist or the platform is unsupported.
 */
export async function lookupOsUser(username: string): Promise<OsUserInfo | null> {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      return await lookupMacOsUser(username);
    } else if (platform === 'linux') {
      return await lookupLinuxUser(username);
    }
    return null;
  } catch (err) {
    logger.error({ username, platform, err }, 'Failed to look up OS user');
    return null;
  }
}

async function lookupMacOsUser(username: string): Promise<OsUserInfo | null> {
  try {
    const uidProc = Bun.spawn(['dscl', '.', '-read', `/Users/${username}`, 'UniqueID'], { stdout: 'pipe', stderr: 'ignore' });
    const uidResult = await new Response(uidProc.stdout).text();
    await uidProc.exited;

    const homeProc = Bun.spawn(['dscl', '.', '-read', `/Users/${username}`, 'NFSHomeDirectory'], { stdout: 'pipe', stderr: 'ignore' });
    const homeResult = await new Response(homeProc.stdout).text();
    await homeProc.exited;

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

async function lookupLinuxUser(username: string): Promise<OsUserInfo | null> {
  try {
    const idProc = Bun.spawn(['id', '-u', username], { stdout: 'pipe', stderr: 'ignore' });
    const result = await new Response(idProc.stdout).text();
    await idProc.exited;

    const uid = parseInt(result.trim(), 10);
    if (isNaN(uid)) return null;

    const getentProc = Bun.spawn(['getent', 'passwd', username], { stdout: 'pipe', stderr: 'ignore' });
    const homeResult = await new Response(getentProc.stdout).text();
    await getentProc.exited;

    const fields = homeResult.trim().split(':');
    // passwd format: username:x:uid:gid:gecos:home:shell
    if (fields.length < 6) return null;

    return { uid, homeDir: fields[5] };
  } catch {
    return null;
  }
}
