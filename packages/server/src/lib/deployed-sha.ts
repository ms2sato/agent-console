/**
 * Reads the deployed-commit marker written by the deploy scripts
 * (`scripts/update-and-deploy-for-*.sh`) into `<deploy-target>/.deploy-sha`.
 *
 * The marker is a server-written, trusted artifact: line 1 is the deployed
 * commit's SHA, line 2 is an ISO-8601 timestamp. This module only reads
 * line 1 -- the timestamp is informational for operators inspecting the
 * marker file directly and is not surfaced over the API.
 *
 * `bun run dev` never writes this marker, so a `null` return is the expected
 * steady state in development.
 */
import { createLogger } from './logger.js';

const logger = createLogger('deployed-sha');

const DEPLOY_SHA_FILENAME = '.deploy-sha';

/**
 * Reads the deployed commit SHA from `<cwd>/.deploy-sha`.
 *
 * @param cwd - Directory to look for the marker in. Defaults to
 *   `process.cwd()`, which equals the deploy target root in every deploy
 *   script's systemd/launchd unit (`WorkingDirectory` is set to the same
 *   path the marker is written into).
 * @returns The trimmed SHA from line 1, or `null` when the marker is absent
 *   or its first line is empty/whitespace-only.
 */
export async function readDeployedSha(cwd: string = process.cwd()): Promise<string | null> {
  const filePath = `${cwd}/${DEPLOY_SHA_FILENAME}`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }

  const content = await file.text();
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) {
    logger.warn({ filePath }, 'Deploy SHA marker file exists but is empty');
    return null;
  }

  return firstLine;
}
