import { describe, it, expect, mock } from 'bun:test';
import { TLS_CA_FILE_ENV_KEY, createOutboundFetch } from '../outbound-tls.js';

function innerFetch() {
  return mock(async (_i: unknown, _init?: unknown) => new Response('ok'));
}

describe('embedded-agent createOutboundFetch', () => {
  it('env key unset -> the underlying fetch is used with no tls option (Bun bundled list)', async () => {
    const inner = innerFetch();
    const f = createOutboundFetch({}, () => 'unused', inner as unknown as typeof fetch);
    await f('https://example.test/', { method: 'POST' });
    expect('tls' in (inner.mock.calls[0][1] as object)).toBe(false);
  });

  it('env key set -> reads the file once and passes tls.ca on every call', async () => {
    const inner = innerFetch();
    const readFile = mock((_p: string) => 'PEM-TEXT');
    const f = createOutboundFetch({ [TLS_CA_FILE_ENV_KEY]: '/ca/bundle.crt' }, readFile, inner as unknown as typeof fetch);
    await f('https://example.test/a', { method: 'POST', body: 'x' });
    await f('https://example.test/b');
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls[0][0]).toBe('/ca/bundle.crt');
    for (const call of inner.mock.calls) {
      expect((call[1] as { tls: { ca: string } }).tls.ca).toBe('PEM-TEXT');
    }
    expect((inner.mock.calls[0][1] as { method: string; body: string }).body).toBe('x');
  });

  it('env key set but the file unreadable -> the request rejects naming the path, and fetch is never called', async () => {
    const inner = innerFetch();
    const f = createOutboundFetch(
      { [TLS_CA_FILE_ENV_KEY]: '/ca/missing.crt' },
      () => {
        throw new Error('ENOENT');
      },
      inner as unknown as typeof fetch,
    );
    await expect(f('https://example.test/')).rejects.toThrow('/ca/missing.crt');
    expect(inner).not.toHaveBeenCalled();
  });

  it('an EACCES-coded read failure rejects the same way (no fallback for any error code), naming the path', async () => {
    const inner = innerFetch();
    const f = createOutboundFetch(
      { [TLS_CA_FILE_ENV_KEY]: '/ca/locked.crt' },
      () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      inner as unknown as typeof fetch,
    );
    await expect(f('https://example.test/')).rejects.toThrow('/ca/locked.crt');
    expect(inner).not.toHaveBeenCalled();
  });
});
