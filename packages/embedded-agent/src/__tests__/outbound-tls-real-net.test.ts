/**
 * Real-network negative controls for the loop's `createOutboundFetch`, the
 * embedded-agent twin of packages/server/src/lib/__tests__/outbound-tls-real-net.test.ts.
 * Gated on `OUTBOUND_TLS_TEST_URL` so CI is not network-bound; skipped with a
 * logged reason when unset.
 *
 * (a) the OS bundle connects, (b) a valid but UNRELATED CA (a throwaway
 * self-signed CA generated here, so provably not in the endpoint's chain) is
 * rejected as UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
 * An empty `ca` is not a valid negative control (it fails with
 * FailedToOpenSocket, for another reason).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLS_CA_FILE_ENV_KEY, createOutboundFetch } from '../outbound-tls.js';

const TEST_URL = process.env.OUTBOUND_TLS_TEST_URL;
const OS_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

let dir: string;
let unrelatedPath: string;
let unrelatedKeyPath: string;

beforeAll(async () => {
  if (!TEST_URL) return;
  dir = await mkdtemp(join(tmpdir(), 'outbound-tls-loop-'));
  unrelatedPath = join(dir, 'unrelated.crt');
  unrelatedKeyPath = join(dir, 'unrelated.key');
  const proc = Bun.spawn(
    [
      'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', unrelatedKeyPath, '-out', unrelatedPath, '-days', '2',
      '-subj', '/CN=throwaway-unrelated-ca', '-addext', 'basicConstraints=critical,CA:TRUE',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if ((await proc.exited) !== 0) throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
});

afterAll(async () => {
  if (!dir) return;
  await unlink(unrelatedPath).catch(() => {});
  await unlink(unrelatedKeyPath).catch(() => {});
  await rmdir(dir).catch(() => {});
});

describe('loop outbound TLS against a real endpoint (OUTBOUND_TLS_TEST_URL)', () => {
  if (!TEST_URL) {
    console.log('SKIPPED: set OUTBOUND_TLS_TEST_URL (e.g. https://api.github.com/) to run the online negative controls');
  }
  const online = TEST_URL ? it : it.skip;

  online('(a) the OS bundle connects', async () => {
    const res = await createOutboundFetch({ [TLS_CA_FILE_ENV_KEY]: OS_BUNDLE })(TEST_URL!, { method: 'HEAD' });
    // Any HTTP response proves the TLS handshake verified; the status itself
    // is the endpoint's business (e.g. 403 when rate limited).
    expect(res.status).toBeGreaterThan(0);
  });

  online('(b) a valid but unrelated CA is rejected as an unknown issuer', async () => {
    let code: unknown;
    try {
      await createOutboundFetch({ [TLS_CA_FILE_ENV_KEY]: unrelatedPath })(TEST_URL!, { method: 'HEAD' });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  });
});
