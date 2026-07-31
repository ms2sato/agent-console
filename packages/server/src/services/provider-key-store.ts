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
 * file, unreadable file, unparseable JSON, non-object root, or an absent /
 * non-string ref each throw a {@link ProviderKeyStoreError}. The key value
 * itself is NEVER included in a thrown message or a log.
 *
 * `ProviderKeyStoreError.message` is a developer-authored, path-naming string
 * intended for SERVER LOGS ONLY (real absolute path, and for `unreadable` the
 * underlying fs error text). The UI-safe, path-placeholder-only text for each
 * `kind` lives separately in {@link PROVIDER_KEY_STORE_UI_MESSAGES} -- see
 * `embedded-agent-worker-service.ts` step 2 for how the two are bridged at
 * the activation call site (structural allowlist wrap, NOT a new WS/MCP/REST-
 * layer marker class).
 */
import * as path from 'node:path';
import { getConfigDir } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('provider-key-store');

/** Minimal structural type for the DI logger seam below (matches `pino.Logger['warn']`). */
type WarnLogger = { warn: (obj: Record<string, unknown>, msg: string) => void };

/** Discriminates the 5 explicit failure paths in {@link loadProviderKey}. */
export type ProviderKeyStoreErrorKind =
  | 'not-found'
  | 'unreadable'
  | 'invalid-json'
  | 'not-object'
  | 'missing-ref';

/**
 * Thrown by {@link loadProviderKey} for each of its 5 explicit failure paths.
 * `message` keeps the real absolute path (and, for `unreadable`, the
 * underlying fs error text) -- that content is for SERVER LOGS ONLY. Client-
 * facing surfacing must go through {@link PROVIDER_KEY_STORE_UI_MESSAGES},
 * never `message` directly.
 */
export class ProviderKeyStoreError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderKeyStoreErrorKind,
    public readonly ref: string,
  ) {
    super(message);
    this.name = 'ProviderKeyStoreError';
  }
}

/**
 * Fixed, UI-safe message templates keyed by {@link ProviderKeyStoreErrorKind}.
 * Each template takes ONLY `ref` as input -- by construction this guarantees
 * (a) the key value can never appear in a surfaced message (templates never
 * receive it), and (b) the `unreadable` template can never carry the
 * underlying fs error's own text (its template is a fixed sentence pointing
 * to the server log, not an interpolation of any dynamic content). The file
 * is named via the literal placeholder `<AGENT_CONSOLE_HOME>/provider-keys.json`
 * -- never the resolved absolute path, never the bare basename -- and the
 * wording does NOT branch on `AUTH_MODE` (uniform across single-user and
 * multi-user deployments).
 */
export const PROVIDER_KEY_STORE_UI_MESSAGES: Record<ProviderKeyStoreErrorKind, (ref: string) => string> = {
  'not-found': (ref) =>
    `Provider key store <AGENT_CONSOLE_HOME>/provider-keys.json was not found, so apiKeyRef '${ref}' could not be resolved. Create the file (see the multi-user setup guide) or remove the apiKeyRef from this agent's provider configuration.`,
  unreadable: () =>
    `Provider key store <AGENT_CONSOLE_HOME>/provider-keys.json could not be read. Check the server log for details and verify the file's permissions.`,
  'invalid-json': () =>
    `Provider key store <AGENT_CONSOLE_HOME>/provider-keys.json is not valid JSON. Fix the file's contents (it must be a JSON object of "<ref>": "<key>" pairs).`,
  'not-object': () =>
    `Provider key store <AGENT_CONSOLE_HOME>/provider-keys.json must be a JSON object of "<ref>": "<key>" pairs. Fix the file's contents.`,
  'missing-ref': (ref) =>
    `Provider key ref '${ref}' is not present as a non-empty string in <AGENT_CONSOLE_HOME>/provider-keys.json. Add the ref to the key store or remove it from this agent's provider configuration.`,
};

/**
 * Resolve a provider key by its reference name.
 *
 * @param ref The `apiKeyRef` from an embedded-agent definition.
 * @param opts.filePath Override for the key-store path (test seam). Defaults to
 *   `<AGENT_CONSOLE_HOME>/provider-keys.json`.
 * @param opts.logger Override for the mode-warning logger (test seam). Defaults to
 *   the module's structured logger.
 * @throws {@link ProviderKeyStoreError} when the file is missing, unreadable,
 *   unparseable, not a JSON object, or the ref does not map to a non-empty
 *   string. The key value is never included in the message.
 */
export async function loadProviderKey(
  ref: string,
  opts: { filePath?: string; logger?: WarnLogger } = {},
): Promise<string> {
  const filePath = opts.filePath ?? path.join(getConfigDir(), 'provider-keys.json');
  const log = opts.logger ?? logger;

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new ProviderKeyStoreError(
      `Provider key store not found at ${filePath}; cannot resolve apiKeyRef '${ref}'`,
      'not-found',
      ref,
    );
  }

  await warnIfModeInsecure(file, filePath, log);

  let raw: string;
  try {
    raw = await file.text();
  } catch (err) {
    throw new ProviderKeyStoreError(
      `Failed to read provider key store at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      'unreadable',
      ref,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderKeyStoreError(
      `Provider key store at ${filePath} is not valid JSON`,
      'invalid-json',
      ref,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderKeyStoreError(
      `Provider key store at ${filePath} must be a JSON object of { "<ref>": "<key>" }`,
      'not-object',
      ref,
    );
  }

  const value = (parsed as Record<string, unknown>)[ref];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderKeyStoreError(
      `Provider key ref '${ref}' is not present as a non-empty string in ${filePath}`,
      'missing-ref',
      ref,
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
