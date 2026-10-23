import { describe, it, expect, mock } from 'bun:test';
import { join } from 'node:path';
import {
  BUNDLED_CA_SENTINEL,
  OS_DEFAULT_CA_FILE,
  OutboundTlsConfigError,
  createOutboundFetch,
  initOutboundTls,
  resolveOutboundCa,
  type OutboundTlsIo,
} from '../outbound-tls.js';

/** In-memory file table: a missing key throws like a real ENOENT. */
function fakeIo(files: Record<string, string | Error>): OutboundTlsIo {
  return {
    readFile(path) {
      const entry = files[path];
      if (entry === undefined) throw errnoError('ENOENT', `no such file '${path}'`);
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

function errnoError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

describe('resolveOutboundCa', () => {
  it('unset + OS bundle present -> os-default carrying the file text and path', () => {
    const resolved = resolveOutboundCa({}, fakeIo({ [OS_DEFAULT_CA_FILE]: 'OS-PEM' }));
    expect(resolved).toEqual({ ca: 'OS-PEM', path: OS_DEFAULT_CA_FILE, source: 'os-default' });
  });

  it('unset + OS bundle absent -> null (Bun bundled list), no throw', () => {
    expect(resolveOutboundCa({}, fakeIo({}))).toBeNull();
  });

  it('unset + OS bundle unreadable (EACCES) -> throws, naming the OS path and not claiming OUTBOUND_TLS_CA_FILE was set', () => {
    const io = fakeIo({ [OS_DEFAULT_CA_FILE]: errnoError('EACCES', 'permission denied') });
    expect(() => resolveOutboundCa({}, io)).toThrow(OutboundTlsConfigError);
    expect(() => resolveOutboundCa({}, io)).toThrow(OS_DEFAULT_CA_FILE);
    expect(() => resolveOutboundCa({}, io)).not.toThrow(/OUTBOUND_TLS_CA_FILE is set/);
  });

  it('unset + a path component of the OS bundle is not a directory (ENOTDIR) -> throws, naming the OS path', () => {
    const io = fakeIo({ [OS_DEFAULT_CA_FILE]: errnoError('ENOTDIR', 'not a directory') });
    expect(() => resolveOutboundCa({}, io)).toThrow(OS_DEFAULT_CA_FILE);
  });

  it('a configured path that exists -> configured, and wins over the OS bundle', () => {
    const resolved = resolveOutboundCa(
      { OUTBOUND_TLS_CA_FILE: '/etc/custom.crt' },
      fakeIo({ '/etc/custom.crt': 'CUSTOM', [OS_DEFAULT_CA_FILE]: 'OS-PEM' }),
    );
    expect(resolved).toEqual({ ca: 'CUSTOM', path: '/etc/custom.crt', source: 'configured' });
  });

  it('a configured path that is missing refuses, naming the path (no fallback to the OS bundle)', () => {
    // The OS bundle exists here on purpose: a silent fallback would return it.
    const io = fakeIo({ [OS_DEFAULT_CA_FILE]: 'OS-PEM' });
    expect(() => resolveOutboundCa({ OUTBOUND_TLS_CA_FILE: '/nope/ca.crt' }, io)).toThrow(OutboundTlsConfigError);
    expect(() => resolveOutboundCa({ OUTBOUND_TLS_CA_FILE: '/nope/ca.crt' }, io)).toThrow('/nope/ca.crt');
  });

  it('a configured path that is unreadable (EACCES) refuses, naming the path', () => {
    const io = fakeIo({ '/etc/locked.crt': new Error("EACCES: permission denied, open '/etc/locked.crt'") });
    expect(() => resolveOutboundCa({ OUTBOUND_TLS_CA_FILE: '/etc/locked.crt' }, io)).toThrow(
      /\/etc\/locked\.crt.*EACCES/s,
    );
  });

  it('the literal `bundled` -> null without reading any file', () => {
    const readFile = mock((_p: string) => 'x');
    expect(resolveOutboundCa({ OUTBOUND_TLS_CA_FILE: BUNDLED_CA_SENTINEL }, { readFile })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('initOutboundTls (boot entry)', () => {
  it('unset + no OS bundle: returns null and the logger is NOT called', () => {
    const logger = { info: mock(() => {}), warn: mock(() => {}) };
    expect(initOutboundTls({}, fakeIo({}), logger)).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('unset + OS bundle unreadable (EACCES): boot refuses with the OS path in the message, nothing logged', () => {
    const logger = { info: mock(() => {}) };
    const io = fakeIo({ [OS_DEFAULT_CA_FILE]: errnoError('EACCES', 'permission denied') });
    expect(() => initOutboundTls({}, io, logger)).toThrow(OS_DEFAULT_CA_FILE);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('`bundled`: returns null and the logger is NOT called', () => {
    const logger = { info: mock(() => {}), warn: mock(() => {}) };
    expect(initOutboundTls({ OUTBOUND_TLS_CA_FILE: BUNDLED_CA_SENTINEL }, fakeIo({}), logger)).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a CA file in use is announced once with its path and source', () => {
    const logger = { info: mock(() => {}) };
    initOutboundTls({}, fakeIo({ [OS_DEFAULT_CA_FILE]: 'OS-PEM' }), logger);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect((logger.info.mock.calls[0] as unknown[])[0]).toEqual({ path: OS_DEFAULT_CA_FILE, source: 'os-default' });
  });

  it('a configured-but-missing file throws (boot refuses) instead of logging a warning', () => {
    const logger = { info: mock(() => {}) };
    expect(() => initOutboundTls({ OUTBOUND_TLS_CA_FILE: '/nope.crt' }, fakeIo({}), logger)).toThrow('/nope.crt');
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('createOutboundFetch', () => {
  const resolved = { ca: 'PEM-TEXT', path: '/p', source: 'configured' as const };

  it('passes tls.ca on every call when a CA resolved, preserving the caller init', async () => {
    const inner = mock(async (_i: unknown, _init?: unknown) => new Response('ok'));
    const wrapped = createOutboundFetch(resolved, inner as unknown as typeof fetch);
    await wrapped('https://example.test/', { method: 'POST', body: 'b' });
    const [url, init] = inner.mock.calls[0] as [string, { method: string; body: string; tls: { ca: string } }];
    expect(url).toBe('https://example.test/');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('b');
    expect(init.tls.ca).toBe('PEM-TEXT');
  });

  it('keeps other caller tls options and overrides ca', async () => {
    const inner = mock(async (_i: unknown, _init?: unknown) => new Response('ok'));
    const wrapped = createOutboundFetch(resolved, inner as unknown as typeof fetch);
    await wrapped('https://example.test/', { tls: { ca: 'OTHER', rejectUnauthorized: true } } as RequestInit);
    const init = inner.mock.calls[0][1] as { tls: { ca: string; rejectUnauthorized: boolean } };
    expect(init.tls).toEqual({ ca: 'PEM-TEXT', rejectUnauthorized: true });
  });

  it('adds no tls option when no CA resolved (Bun bundled list)', async () => {
    const inner = mock(async (_i: unknown, _init?: unknown) => new Response('ok'));
    const wrapped = createOutboundFetch(null, inner as unknown as typeof fetch);
    await wrapped('https://example.test/', { method: 'GET' });
    expect('tls' in (inner.mock.calls[0][1] as object)).toBe(false);
  });
});

describe('server bootstrap wiring (src/index.ts)', () => {
  // index.ts runs the whole server at import, so it cannot be imported by a
  // test; this pins its source instead (same approach as the embedded-agent
  // main.ts wiring pin). A configured-but-unreadable OUTBOUND_TLS_CA_FILE must
  // refuse boot BEFORE any service is created, so the call must exist and
  // precede createAppContext.
  it('calls initOutboundTls() before createAppContext()', async () => {
    const source = await Bun.file(join(import.meta.dir, '..', '..', 'index.ts')).text();
    // Line-anchored so a commented-out call does not count.
    const initAt = source.search(/^\s*initOutboundTls\(\);/m);
    const contextAt = source.indexOf('await createAppContext(');
    expect(initAt).toBeGreaterThan(-1);
    expect(contextAt).toBeGreaterThan(-1);
    expect(initAt).toBeLessThan(contextAt);
  });
});
