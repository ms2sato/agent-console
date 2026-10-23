/**
 * Outbound TLS trust for the server's own `fetch` calls.
 *
 * Bun ships its own CA list and cannot replace it process-wide; the only
 * per-call lever is `fetch(url, { tls: { ca } })`. This module resolves the
 * CA bundle once (OS bundle by default) and wraps `fetch` so the server's
 * outbound HTTPS verifies against it. `tls.setDefaultCACertificates` is NOT
 * used: measured on Bun 1.4.4, it does not govern `fetch`.
 *
 * Semantics of `OUTBOUND_TLS_CA_FILE` (owner ruling 2026-10-24):
 * - unset, OS bundle present  -> `os-default`
 * - unset, OS bundle absent   -> `null` (Bun's bundled list), SILENTLY
 * - a path                    -> that file; missing/unreadable throws
 *                                `OutboundTlsConfigError` (boot refuses)
 * - literal `bundled`         -> `null`, no warning
 *
 * The embedded-agent loop has its own copy of the wrapper
 * (packages/embedded-agent/src/outbound-tls.ts) because it runs as another OS
 * user and cannot import server code; the server hands it the resolved path
 * as `AGENT_CONSOLE_TLS_CA_FILE`.
 */
import { readFileSync } from 'node:fs';
import { serverConfig } from './server-config.js';
import { createLogger } from './logger.js';

export const OS_DEFAULT_CA_FILE = '/etc/ssl/certs/ca-certificates.crt';
export const BUNDLED_CA_SENTINEL = 'bundled';

export interface ResolvedOutboundCa {
  /** PEM text of the CA bundle. */
  ca: string;
  /** File the bundle was read from (handed to the embedded-agent loop). */
  path: string;
  source: 'configured' | 'os-default';
}

export interface OutboundTlsIo {
  readFile(path: string): string;
}

export class OutboundTlsConfigError extends Error {
  constructor(
    readonly caFilePath: string,
    cause: unknown,
  ) {
    super(
      `OUTBOUND_TLS_CA_FILE is set to '${caFilePath}' but the file cannot be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Fix the path, or set it to '${BUNDLED_CA_SENTINEL}' to use Bun's bundled CA list.`,
    );
    this.name = 'OutboundTlsConfigError';
  }
}

const defaultIo: OutboundTlsIo = { readFile: (path) => readFileSync(path, 'utf8') };

/**
 * Pure resolution of the CA bundle from config. Never logs: every `null`
 * outcome is an operator-expressed or default choice, not a degraded mode.
 */
export function resolveOutboundCa(
  config: { OUTBOUND_TLS_CA_FILE?: string },
  io: OutboundTlsIo = defaultIo,
): ResolvedOutboundCa | null {
  const configured = config.OUTBOUND_TLS_CA_FILE;
  if (configured === BUNDLED_CA_SENTINEL) return null;
  if (configured !== undefined) {
    try {
      return { ca: io.readFile(configured), path: configured, source: 'configured' };
    } catch (error) {
      throw new OutboundTlsConfigError(configured, error);
    }
  }
  try {
    return { ca: io.readFile(OS_DEFAULT_CA_FILE), path: OS_DEFAULT_CA_FILE, source: 'os-default' };
  } catch {
    return null;
  }
}

let cached: { value: ResolvedOutboundCa | null } | undefined;

/** Resolve once from `serverConfig` and cache. Throws `OutboundTlsConfigError`. */
export function getOutboundCa(): ResolvedOutboundCa | null {
  if (cached === undefined) {
    cached = { value: resolveOutboundCa(serverConfig) };
  }
  return cached.value;
}

/**
 * Boot-time entry: resolve eagerly so a configured-but-unreadable file stops
 * the server before it serves anything, and cache the result for
 * `getOutboundCa`. Logs one info line only when a CA file is in use; the
 * `null` outcomes (unset with no OS bundle, or `bundled`) stay silent.
 */
export function initOutboundTls(
  config: { OUTBOUND_TLS_CA_FILE?: string } = serverConfig,
  io: OutboundTlsIo = defaultIo,
  logger: Pick<ReturnType<typeof createLogger>, 'info'> = createLogger('outbound-tls'),
): ResolvedOutboundCa | null {
  const resolved = resolveOutboundCa(config, io);
  cached = { value: resolved };
  if (resolved) {
    logger.info(
      { path: resolved.path, source: resolved.source },
      'Outbound TLS verifies against the CA file',
    );
  }
  return resolved;
}

/** @internal Exported for testing */
export function resetOutboundTlsCacheForTest(): void {
  cached = undefined;
}

/** `fetch` that verifies against `resolved.ca` when one is given. */
/** The callable part of `typeof fetch` (without Bun's `preconnect`). */
type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export function createOutboundFetch(
  resolved: ResolvedOutboundCa | null,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!resolved) return fetchImpl(input, init);
    const existingTls = (init as { tls?: object } | undefined)?.tls;
    return fetchImpl(input, { ...init, tls: { ...existingTls, ca: resolved.ca } } as RequestInit);
  };
  return wrapped as typeof fetch;
}

/** The server's outbound `fetch`: use instead of bare `fetch` for any external HTTPS call. */
export const outboundFetch: typeof fetch = ((input, init) =>
  createOutboundFetch(getOutboundCa())(input, init)) as typeof fetch;
