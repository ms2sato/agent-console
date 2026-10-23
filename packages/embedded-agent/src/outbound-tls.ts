/**
 * Outbound TLS trust for the loop's own `fetch` (the `openai-api` provider
 * calls). Same contract as the server's `lib/outbound-tls.ts`, kept as its
 * own copy because the loop runs as another OS user and cannot import server
 * code.
 *
 * The server injects `AGENT_CONSOLE_TLS_CA_FILE` into the loop's spawn env
 * (`AGENT_CONSOLE_RUNTIME_ENV_KEYS`, packages/shared) when it resolved a CA
 * bundle. Unset means Bun's bundled list. When set, the file is read lazily
 * on the first request and a read failure rejects that request (fail closed:
 * a trust file the server vouched for must not silently degrade to another
 * list). The `Bash` tool's children never see the variable (`buildBashEnv`).
 */
import { readFileSync } from 'node:fs';

export const TLS_CA_FILE_ENV_KEY = 'AGENT_CONSOLE_TLS_CA_FILE';

/** The callable part of `typeof fetch` (without Bun's `preconnect`). */
type FetchLike = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export function createOutboundFetch(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  const caPath = env[TLS_CA_FILE_ENV_KEY];
  if (!caPath) return fetchImpl as typeof fetch;
  let ca: string | undefined;
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (ca === undefined) {
      try {
        ca = readFile(caPath);
      } catch (error) {
        return Promise.reject(
          new Error(
            `${TLS_CA_FILE_ENV_KEY} is set to '${caPath}' but the file cannot be read: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    const existingTls = (init as { tls?: object } | undefined)?.tls;
    return fetchImpl(input, { ...init, tls: { ...existingTls, ca } } as RequestInit);
  };
  return wrapped as typeof fetch;
}
