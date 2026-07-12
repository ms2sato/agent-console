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

/**
 * Resolve a provider key by its reference name.
 *
 * @param ref The `apiKeyRef` from an embedded-agent definition.
 * @param opts.filePath Override for the key-store path (test seam). Defaults to
 *   `<AGENT_CONSOLE_HOME>/provider-keys.json`.
 * @throws Error when the file is missing, unparseable, or the ref does not map
 *   to a non-empty string. The key value is never included in the message.
 */
export async function loadProviderKey(
  ref: string,
  opts: { filePath?: string } = {},
): Promise<string> {
  const filePath = opts.filePath ?? path.join(getConfigDir(), 'provider-keys.json');

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(
      `Provider key store not found at ${filePath}; cannot resolve apiKeyRef '${ref}'`,
    );
  }

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
