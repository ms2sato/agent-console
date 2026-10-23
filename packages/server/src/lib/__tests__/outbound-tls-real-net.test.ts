/**
 * Real-network negative controls for `lib/outbound-tls.ts` (second `bun test`
 * invocation, see packages/server/package.json; the file calls `assertRealFs`
 * because it writes throwaway key material to a real temp dir).
 *
 * Two halves:
 *
 * 1. Online, gated on `OUTBOUND_TLS_TEST_URL` (e.g. `https://api.github.com/`)
 *    so CI is not network-bound; skipped with a logged reason when unset.
 *    (a) the OS bundle connects, (b) a valid but UNRELATED CA is rejected with
 *    UNABLE_TO_GET_ISSUER_CERT_LOCALLY (proves the given list is used, not
 *    Bun's bundled one), (c) plain `fetch` connects (the network is up).
 *    The unrelated CA is a throwaway self-signed CA generated here, so it is
 *    provably not in any real endpoint's chain. An empty `ca` is NOT a valid
 *    negative control: it fails with FailedToOpenSocket, for another reason.
 *
 * 2. Offline: the Slack path (`SlackHandler.sendToWebhook`) against a local
 *    `Bun.serve` TLS endpoint with a self-signed cert. Passes with that cert
 *    as the CA, fails with the OS bundle (the inverse pairing).
 *
 * Must not load any module that calls `mock.module` (real-fs-invocation.test.ts
 * check iv).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRealFs } from '../../__tests__/utils/memfs-detection.js';
import {
  OS_DEFAULT_CA_FILE,
  createOutboundFetch,
  resolveOutboundCa,
  type ResolvedOutboundCa,
} from '../outbound-tls.js';
import { SlackHandler } from '../../services/notifications/slack-handler.js';

const TEST_URL = process.env.OUTBOUND_TLS_TEST_URL;

interface Pair {
  keyPath: string;
  certPath: string;
  cert: string;
  key: string;
}

async function generateSelfSigned(dir: string, name: string, cn: string): Promise<Pair> {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  const proc = Bun.spawn(
    [
      'openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', `/CN=${cn}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`openssl failed: ${await new Response(proc.stderr).text()}`);
  return { keyPath, certPath, key: await readFile(keyPath, 'utf8'), cert: await readFile(certPath, 'utf8') };
}

let dir: string;
let unrelated: Pair;
let localServerPair: Pair;

beforeAll(async () => {
  await assertRealFs('outbound-tls-real-net');
  dir = await mkdtemp(join(tmpdir(), 'outbound-tls-'));
  unrelated = await generateSelfSigned(dir, 'unrelated', 'throwaway-unrelated-ca');
  localServerPair = await generateSelfSigned(dir, 'local', 'localhost');
});

afterAll(async () => {
  for (const p of [unrelated, localServerPair]) {
    if (!p) continue;
    await unlink(p.keyPath).catch(() => {});
    await unlink(p.certPath).catch(() => {});
  }
  if (dir) await rmdir(dir).catch(() => {});
});

function asResolved(pair: Pair): ResolvedOutboundCa {
  return { ca: pair.cert, path: pair.certPath, source: 'configured' };
}

describe('outbound TLS against a real endpoint (OUTBOUND_TLS_TEST_URL)', () => {
  if (!TEST_URL) {
    console.log('SKIPPED: set OUTBOUND_TLS_TEST_URL (e.g. https://api.github.com/) to run the online negative controls');
  }
  const online = TEST_URL ? it : it.skip;

  online('(a) the OS bundle connects', async () => {
    const os = resolveOutboundCa({});
    expect(os?.path).toBe(OS_DEFAULT_CA_FILE);
    const res = await createOutboundFetch(os)(TEST_URL!, { method: 'HEAD' });
    expect(res.status).toBeLessThan(400);
  });

  online('(b) a valid but unrelated CA is rejected as an unknown issuer', async () => {
    const f = createOutboundFetch(asResolved(unrelated));
    let code: unknown;
    try {
      await f(TEST_URL!, { method: 'HEAD' });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  });

  online('(c) plain fetch connects (the network is up)', async () => {
    const res = await fetch(TEST_URL!, { method: 'HEAD' });
    expect(res.status).toBeLessThan(400);
  });
});

describe('Slack path against a local TLS endpoint with a self-signed cert (offline)', () => {
  let server: ReturnType<typeof Bun.serve>;
  let received = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { key: localServerPair.key, cert: localServerPair.cert },
      fetch() {
        received++;
        return new Response('ok');
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
  });

  const context = {
    session: { id: 's1', title: 'T', worktreeId: 'wt' },
    worker: { id: 'w1' },
    event: { type: 'agent:idle', activityState: 'idle', timestamp: '2025-01-01T00:00:00Z' },
    agentConsoleUrl: 'http://localhost:5555/sessions/s1',
  } as const;

  it('succeeds when the self-signed cert is the CA', async () => {
    const handler = new SlackHandler(Object.create(null), createOutboundFetch(asResolved(localServerPair)));
    const before = received;
    await handler.sendToWebhook(context, `https://localhost:${server.port}/hook`);
    expect(received).toBe(before + 1);
  });

  it('fails when the OS bundle is the CA (the cert is not publicly trusted)', async () => {
    const os = resolveOutboundCa({});
    expect(os).not.toBeNull();
    const handler = new SlackHandler(Object.create(null), createOutboundFetch(os));
    const before = received;
    await expect(handler.sendToWebhook(context, `https://localhost:${server.port}/hook`)).rejects.toThrow();
    expect(received).toBe(before);
  });
});
