/**
 * Provider key store for embedded-agent activation.
 *
 * Resolves an `EmbeddedAgentDefinition.provider.apiKeyRef` to the actual API
 * key held server-side in `<AGENT_CONSOLE_HOME>/provider-keys.json` (mode 0600,
 * owned by the server user, shape `{ "<ref>": "<key>" }`). The resolved key is
 * delivered to the subprocess over the already-piped stdin init message, never
 * via argv or env — see docs/design/embedded-agent-worker.md § "Credentials".
 *
 * Every failure path is explicit and surfaced to the client (a dangling ref
 * fails activation rather than silently falling back to keyless): a missing
 * file, unparseable JSON, or an absent / non-string ref each throw a clear
 * Error. The key value itself is NEVER included in a thrown message or a log.
 */
import * as path from 'node:path';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('provider-key-store');

/** Minimal structural type for the DI logger seam below (matches `pino.Logger['warn']`). */
type WarnLogger = { warn: (obj: Record<string, unknown>, msg: string) => void };

/**
 * Resolve a provider key by its reference name.
 *
 * @param ref The `apiKeyRef` from an embedded-agent definition.
 * @param opts.filePath Override for the key-store path (test seam). Defaults to
 *   `<AGENT_CONSOLE_HOME>/provider-keys.json`.
 * @param opts.logger Override for the mode-warning logger (test seam). Defaults to
 *   the module's structured logger.
 * @throws Error when the file is missing, unparseable, or the ref does not map
 *   to a non-empty string. The key value is never included in the message.
 */
export async function loadProviderKey(
  ref: string,
  opts: { filePath?: string; logger?: WarnLogger } = {},
): Promise<string> {
  const filePath = opts.filePath ?? path.join(getConfigDir(), 'provider-keys.json');
  const log = opts.logger ?? logger;

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(
      `Provider key store not found at ${filePath}; cannot resolve apiKeyRef '${ref}'`,
    );
  }

  await warnIfModeInsecure(file, filePath, log);

  let raw: string;
  try {
    raw = await file.text();
  } catch (err) {
    throw new Error(
      `Failed to read provider key store at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Provider key store at ${filePath} is not valid JSON`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Provider key store at ${filePath} must be a JSON object of { "<ref>": "<key>" }`,
    );
  }

  const value = (parsed as Record<string, unknown>)[ref];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Provider key ref '${ref}' is not present as a non-empty string in ${filePath}`,
    );
  }

  return value;
}

/**
 * Warn (never throw) when the key store file's permission bits allow group
 * or world access. Advisory only, matching the operator-managed v1 posture:
 * a misconfigured mode should be visible in logs, not block activation.
 *
 * Reads via the same `BunFile` handle `loadProviderKey` uses for `.exists()`
 * / `.text()` (not `node:fs`/`node:fs/promises`) so this stays consistent
 * under bun:test's process-global `memfs` mock of `node:fs` in sibling test
 * files — see the NOTE in `__tests__/provider-key-store.test.ts`.
 */
async function warnIfModeInsecure(
  file: ReturnType<typeof Bun.file>,
  filePath: string,
  log: WarnLogger,
): Promise<void> {
  let mode: number;
  try {
    mode = (await file.stat()).mode & 0o777;
  } catch {
    return;
  }

  if ((mode & 0o077) !== 0) {
    log.warn(
      { filePath, mode: mode.toString(8) },
      `provider-keys.json mode is 0${mode.toString(8)}, should be 0600 (world/group readable)`,
    );
  }
}
