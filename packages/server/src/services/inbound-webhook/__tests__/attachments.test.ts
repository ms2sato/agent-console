/**
 * Attachment fetch of the inbound webhook (receive half). Every URL and token here is an obviously
 * neutral placeholder. The injected `fetch` is a test double: the host pin forbids reaching the
 * real host from a test, so a stub stands in for it (a recorded proxy).
 *
 * Bun's test timeout does not fire on a never-settling await, so every test that could hang races
 * its call against `guard()`.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import { rootLogger } from '../../../lib/logger.js';
import {
  fetchAttachments,
  parseAllowedAttachmentUrl,
  sanitizeAttachmentName,
  uniqueAttachmentNames,
  type AttachmentFetch,
  type AttachmentFetchLimits,
  type AttachmentFileEntry,
} from '../attachments.js';

const HOST = 'firebasestorage.googleapis.com';
const TOKEN = 'tok-NEUTRAL-0001';
const LIMITS: AttachmentFetchLimits = { timeoutMs: 5_000, maxBytes: 1_000, maxCount: 10 };

const urlFor = (n: number | string) => `https://${HOST}/v0/b/bucket-NEUTRAL/o/file-${n}.bin?alt=media&token=${TOKEN}-${n}`;
const entry = (n: number | string, extra: Partial<AttachmentFileEntry> = {}): AttachmentFileEntry => ({
  name: `file-${n}.bin`,
  url: urlFor(n),
  ...extra,
});

function guard<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('test guard: call did not settle')), ms)),
  ]);
}

interface FetchCall {
  url: string;
  redirect: string;
}

function recordingFetch(respond: (url: string, signal: AbortSignal) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const impl: AttachmentFetch = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    return respond(url, init.signal);
  };
  return { impl, calls };
}

const okBytes = (bytes: Uint8Array | string) => () => new Response(bytes, { status: 200 });

/** A body that yields `chunkSize`-byte chunks until `totalBytes` (Infinity for never-ending), reading lazily. */
function chunkedBody(totalBytes: number, chunkSize: number, probe: { produced: number; cancelled: boolean }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (probe.produced >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, totalBytes - probe.produced);
        probe.produced += size;
        controller.enqueue(new Uint8Array(size).fill(7));
      },
      cancel() {
        probe.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

describe('parseAllowedAttachmentUrl and the host pin', () => {
  const refused: Array<[string, string | undefined]> = [
    ['a suffix-extended look-alike host', `https://${HOST}.evil.test/x`],
    ['the pinned host in the path of another host', `https://evil.test/${HOST}/x`],
    ['the pinned host as a sub-domain prefix of another', `https://sub.${HOST}/x`],
    ['the pinned host inside the query of another host', `https://evil.test/x?h=${HOST}`],
    ['plain http', `http://${HOST}/x`],
    ['userinfo', `https://user@${HOST}/x`],
    ['userinfo with password', `https://user:pw-NEUTRAL@${HOST}/x`],
    ['an explicit non-default port', `https://${HOST}:8443/x`],
    ['an IPv4 literal', 'https://203.0.113.7/x'],
    ['an IPv6 literal', 'https://[2001:db8::1]/x'],
    ['a trailing-dot host', `https://${HOST}./x`],
    ['another scheme', `ftp://${HOST}/x`],
    ['a malformed URL', 'https://'],
    ['not a URL at all', 'not a url'],
    ['an empty string', ''],
    ['no url', undefined],
  ];

  for (const [label, url] of refused) {
    it(`refuses ${label} and makes no network call`, async () => {
      expect(parseAllowedAttachmentUrl(url)).toBeNull();
      const { impl, calls } = recordingFetch(okBytes('x'));
      const result = await guard(fetchAttachments([{ name: 'a.bin', url }], { fetch: impl, limits: LIMITS }));
      expect(calls).toHaveLength(0);
      expect(result).toEqual({ fetched: [], skipped: 1 });
    });
  }

  it('decision: an upper-case spelling is the pinned host (the parser normalizes it) and is fetched under the normalized form', async () => {
    const { impl, calls } = recordingFetch(okBytes('x'));
    const result = await guard(
      fetchAttachments([{ name: 'a.bin', url: `https://${HOST.toUpperCase()}/v0/b/bucket-NEUTRAL/o/f?token=${TOKEN}` }], { fetch: impl, limits: LIMITS }),
    );
    expect(result.fetched).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://${HOST}/v0/b/bucket-NEUTRAL/o/f?token=${TOKEN}`);
  });

  it('decision: the default port spelled out (:443) is not an explicit non-default port and is accepted', () => {
    expect(parseAllowedAttachmentUrl(`https://${HOST}:443/x`)).not.toBeNull();
  });

  it('accepts the documented URL shape', () => {
    expect(parseAllowedAttachmentUrl(urlFor(1))?.hostname).toBe(HOST);
  });
});

describe('fetchAttachments: transfer rules', () => {
  it('passes redirect: manual on every call', async () => {
    const { impl, calls } = recordingFetch(okBytes('x'));
    await guard(fetchAttachments([entry(1), entry(2)], { fetch: impl, limits: LIMITS }));
    expect(calls.map((c) => c.redirect)).toEqual(['manual', 'manual']);
  });

  for (const status of [301, 302, 307, 308]) {
    it(`a ${status} response is skipped and never followed`, async () => {
      const { impl, calls } = recordingFetch(
        () => new Response(null, { status, headers: { location: `https://${HOST}/elsewhere` } }),
      );
      const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }));
      expect(result).toEqual({ fetched: [], skipped: 1 });
      expect(calls).toHaveLength(1);
    });
  }

  it('an opaque-redirect response is skipped even though its status looks successful', async () => {
    const { impl } = recordingFetch(() => {
      const response = new Response('x', { status: 200 });
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    });
    expect(await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }))).toEqual({ fetched: [], skipped: 1 });
  });

  for (const status of [400, 403, 404, 500]) {
    it(`a ${status} response is skipped`, async () => {
      const { impl } = recordingFetch(() => new Response('nope', { status }));
      expect(await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }))).toEqual({ fetched: [], skipped: 1 });
    });
  }

  it('returns the bytes of a successful response', async () => {
    const { impl } = recordingFetch(okBytes(new Uint8Array([1, 2, 3, 0, 255])));
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }));
    expect(result.skipped).toBe(0);
    expect(result.fetched).toHaveLength(1);
    expect(Array.from(result.fetched[0]!.bytes)).toEqual([1, 2, 3, 0, 255]);
    expect(result.fetched[0]!.name).toBe('file-1.bin');
  });

  it('an empty file is fetched as zero bytes', async () => {
    const { impl } = recordingFetch(() => new Response(null, { status: 200 }));
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }));
    expect(result.fetched[0]!.bytes.byteLength).toBe(0);
  });
});

describe('fetchAttachments: size cap', () => {
  it('a declared size over the cap is skipped without a network call; exactly the cap is attempted', async () => {
    const { impl, calls } = recordingFetch(okBytes('x'));
    const over = await guard(fetchAttachments([entry(1, { size: 1_001 })], { fetch: impl, limits: LIMITS }));
    expect(over).toEqual({ fetched: [], skipped: 1 });
    expect(calls).toHaveLength(0);
    const exact = await guard(fetchAttachments([entry(1, { size: 1_000 })], { fetch: impl, limits: LIMITS }));
    expect(exact.fetched).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('a Content-Length over the cap is skipped before any body byte is read, and the body is cancelled', async () => {
    const probe = { produced: 0, cancelled: false };
    const { impl } = recordingFetch(
      () => new Response(chunkedBody(5_000, 100, probe), { status: 200, headers: { 'content-length': '5000' } }),
    );
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }));
    expect(result).toEqual({ fetched: [], skipped: 1 });
    expect(probe.produced).toBe(0);
    expect(probe.cancelled).toBe(true);
  });

  it('without a length, a stream of exactly the cap is accepted and cap+1 is rejected', async () => {
    const exact = { produced: 0, cancelled: false };
    const accepted = await guard(
      fetchAttachments([entry(1)], {
        fetch: recordingFetch(() => new Response(chunkedBody(1_000, 300, exact), { status: 200 })).impl,
        limits: LIMITS,
      }),
    );
    expect(accepted.fetched).toHaveLength(1);
    expect(accepted.fetched[0]!.bytes.byteLength).toBe(1_000);

    const over = { produced: 0, cancelled: false };
    const rejected = await guard(
      fetchAttachments([entry(1)], {
        fetch: recordingFetch(() => new Response(chunkedBody(1_001, 1, over), { status: 200 })).impl,
        limits: LIMITS,
      }),
    );
    expect(rejected).toEqual({ fetched: [], skipped: 1 });
  });

  it('stops reading and cancels the stream once the running total passes the cap: bytes read stay near the cap, not the whole body', async () => {
    const probe = { produced: 0, cancelled: false };
    const { impl } = recordingFetch(() => new Response(chunkedBody(1_000_000, 100, probe), { status: 200 }));
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }));
    expect(result).toEqual({ fetched: [], skipped: 1 });
    expect(probe.cancelled).toBe(true);
    expect(probe.produced).toBeLessThanOrEqual(LIMITS.maxBytes + 200);
    expect(probe.produced).toBeLessThan(1_000_000);
  });
});

describe('fetchAttachments: timeout', () => {
  it('abandons a fetch that never settles at the timeout (the fake honours the signal)', async () => {
    const { impl } = recordingFetch(
      (_url, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const started = Date.now();
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: { ...LIMITS, timeoutMs: 40 } }));
    expect(result).toEqual({ fetched: [], skipped: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('abandons a fetch that ignores the signal altogether', async () => {
    const { impl } = recordingFetch(() => new Promise<Response>(() => {}));
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: { ...LIMITS, timeoutMs: 40 } }));
    expect(result).toEqual({ fetched: [], skipped: 1 });
  });

  it('abandons a body that stalls after the headers and cancels it', async () => {
    const probe = { cancelled: false };
    const stalled = new ReadableStream<Uint8Array>(
      {
        pull: () => new Promise<void>(() => {}),
        cancel() {
          probe.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { impl } = recordingFetch(() => new Response(stalled, { status: 200 }));
    const result = await guard(fetchAttachments([entry(1)], { fetch: impl, limits: { ...LIMITS, timeoutMs: 40 } }));
    expect(result).toEqual({ fetched: [], skipped: 1 });
    expect(probe.cancelled).toBe(true);
  });

  it('a timeout on one file does not stop the next', async () => {
    const { impl } = recordingFetch((url, signal) =>
      url.includes('file-1.bin')
        ? new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        : new Response('ok', { status: 200 }),
    );
    const result = await guard(fetchAttachments([entry(1), entry(2)], { fetch: impl, limits: { ...LIMITS, timeoutMs: 40 } }));
    expect(result.fetched.map((f) => f.name)).toEqual(['file-2.bin']);
    expect(result.skipped).toBe(1);
  });
});

describe('fetchAttachments: count cap and isolation', () => {
  it('attempts at most maxCount files in payload order and counts the rest as skipped', async () => {
    const { impl, calls } = recordingFetch(okBytes('x'));
    const files = Array.from({ length: 11 }, (_unused, i) => entry(i + 1));
    const result = await guard(fetchAttachments(files, { fetch: impl, limits: LIMITS }));
    expect(calls).toHaveLength(10);
    expect(calls.map((c) => c.url)).toEqual(files.slice(0, 10).map((f) => f.url ?? ''));
    expect(result.fetched).toHaveLength(10);
    expect(result.skipped).toBe(1);
  });

  it('exactly maxCount files are all attempted', async () => {
    const { impl, calls } = recordingFetch(okBytes('x'));
    const result = await guard(fetchAttachments(Array.from({ length: 10 }, (_u, i) => entry(i + 1)), { fetch: impl, limits: LIMITS }));
    expect(calls).toHaveLength(10);
    expect(result.skipped).toBe(0);
  });

  it('no files: nothing fetched, nothing skipped', async () => {
    const { impl, calls } = recordingFetch(okBytes('x'));
    expect(await guard(fetchAttachments([], { fetch: impl, limits: LIMITS }))).toEqual({ fetched: [], skipped: 0 });
    expect(calls).toHaveLength(0);
  });

  it('one bad file among good ones: the good ones are fetched, the bad one is counted, nothing throws', async () => {
    const { impl } = recordingFetch((url) => {
      if (url.includes('file-2.bin')) throw new Error('boom');
      if (url.includes('file-3.bin')) return new Response('nope', { status: 500 });
      return new Response('ok', { status: 200 });
    });
    const files = [entry(1), entry(2), entry(3), { name: 'x.bin', url: 'https://evil.test/x' }, entry(5)];
    const result = await guard(fetchAttachments(files, { fetch: impl, limits: LIMITS }));
    expect(result.fetched.map((f) => f.name)).toEqual(['file-1.bin', 'file-5.bin']);
    expect(result.skipped).toBe(3);
  });

  it('never retries a failed file', async () => {
    const { impl, calls } = recordingFetch(() => new Response('nope', { status: 503 }));
    await guard(fetchAttachments([entry(1)], { fetch: impl, limits: LIMITS }));
    expect(calls).toHaveLength(1);
  });
});

describe('fetchAttachments: the URL and its token never leave the function', () => {
  it('appear in no returned value, and in no log call when the fetch throws an Error that embeds both', async () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const spies = levels.map((level) => spyOn(rootLogger, level));
    try {
      const { impl } = recordingFetch((url) => {
        if (url.includes('file-1.bin')) throw new Error(`connect failed for ${url} with token ${TOKEN}-1`);
        if (url.includes('file-2.bin')) return new Response('nope', { status: 500 });
        return new Response('ok', { status: 200 });
      });
      const result = await guard(fetchAttachments([entry(1), entry(2), entry(3)], { fetch: impl, limits: LIMITS }));

      const calls = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      // Positive control: the spies did observe the skip records.
      expect(spies.flatMap((spy) => spy.mock.calls).length).toBeGreaterThan(0);
      expect(calls).toContain('Inbound webhook attachment skipped');
      for (const secret of [TOKEN, HOST, 'bucket-NEUTRAL', 'connect failed']) {
        expect(calls).not.toContain(secret);
      }
      const returned = JSON.stringify({ ...result, fetched: result.fetched.map((f) => f.name) });
      expect(returned).not.toContain(TOKEN);
      expect(returned).not.toContain(HOST);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('sanitizeAttachmentName', () => {
  const table: Array<[string, string | undefined, string]> = [
    ['a traversal path keeps only its last component', '../../etc/passwd', 'passwd'],
    ['a relative path keeps only its last component', 'a/b.png', 'b.png'],
    ['a backslash path keeps only its last component', 'C:\\Users\\x\\report.pdf', 'report.pdf'],
    ['a trailing separator keeps the last real component', 'dir/', 'dir'],
    ['dot-dot becomes the fallback', '..', 'attachment'],
    ['dot becomes the fallback', '.', 'attachment'],
    ['only dots becomes the fallback', '....', 'attachment'],
    ['empty becomes the fallback', '', 'attachment'],
    ['undefined becomes the fallback', undefined, 'attachment'],
    ['whitespace only becomes the fallback', '   ', 'attachment'],
    ['a separator-only name becomes the fallback', '///', 'attachment'],
    ['NUL is removed', 'a\u0000b.png', 'ab.png'],
    ['control characters are removed', 'a\u0001\u001f\u007f\u0085b\n\r\t.png', 'ab.png'],
    ['bidi override and line separator are removed', 'evil\u202egnp.exe\u2028', 'evilgnp.exe'],
    ['a name that is only controls becomes the fallback', '\u0000\u0001', 'attachment'],
    ['only an extension is kept as a name', '.png', '.png'],
    ['a plain name is unchanged', 'report final (1).pdf', 'report final (1).pdf'],
    ['a multi-byte name is unchanged', 'report-\u65e5\u672c\u8a9e.pdf', 'report-\u65e5\u672c\u8a9e.pdf'],
  ];
  for (const [label, input, expected] of table) {
    it(label, () => {
      expect(sanitizeAttachmentName(input)).toBe(expected);
    });
  }

  it('caps a 300-character name at 100 code points and keeps the extension', () => {
    const name = sanitizeAttachmentName(`${'a'.repeat(300)}.png`);
    expect(Array.from(name)).toHaveLength(100);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('caps a 300-character name without an extension at 100 code points', () => {
    expect(Array.from(sanitizeAttachmentName('b'.repeat(300)))).toHaveLength(100);
  });

  it('never splits a surrogate pair at the cut', () => {
    // 99 ASCII characters then a 2-unit emoji: the 100th code point is the emoji, kept whole.
    const atCut = sanitizeAttachmentName(`${'a'.repeat(99)}\u{1F600}${'z'.repeat(50)}`);
    expect(Array.from(atCut)).toHaveLength(100);
    expect(atCut.endsWith('\u{1F600}')).toBe(true);
    // 100 ASCII characters then the emoji: cut before it, no lone surrogate left.
    const afterCut = sanitizeAttachmentName(`${'a'.repeat(100)}\u{1F600}`);
    expect(afterCut).toBe('a'.repeat(100));
    expect(/[\ud800-\udfff]/.test(afterCut.replace(/[\u{10000}-\u{10FFFF}]/gu, ''))).toBe(false);
  });

  it('keeps a multi-byte name inside the byte cap as well', () => {
    const name = sanitizeAttachmentName(`${'\u{1F600}'.repeat(100)}.png`);
    expect(Buffer.byteLength(name, 'utf-8')).toBeLessThanOrEqual(240);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('treats an over-long trailing part as part of the stem, not as an extension', () => {
    const name = sanitizeAttachmentName(`a.${'x'.repeat(200)}`);
    expect(Array.from(name)).toHaveLength(100);
  });
});

describe('uniqueAttachmentNames and its use in fetchAttachments', () => {
  it('numbers duplicates before the extension, deterministically', () => {
    expect(uniqueAttachmentNames(['a.png', 'a.png', 'b.png', 'a.png'])).toEqual(['a.png', 'a-2.png', 'b.png', 'a-3.png']);
  });

  it('compares ignoring case', () => {
    expect(uniqueAttachmentNames(['A.png', 'a.png'])).toEqual(['A.png', 'a-2.png']);
  });

  it('does not collide with a name that already looks like a numbered duplicate', () => {
    expect(uniqueAttachmentNames(['a.png', 'a-2.png', 'a.png'])).toEqual(['a.png', 'a-2.png', 'a-3.png']);
  });

  it('numbers a name without an extension', () => {
    expect(uniqueAttachmentNames(['notes', 'notes'])).toEqual(['notes', 'notes-2']);
  });

  it('keeps the cap when numbering a name already at 100 code points', () => {
    const long = 'c'.repeat(100);
    const [first, second] = uniqueAttachmentNames([long, long]);
    expect(first).toBe(long);
    expect(Array.from(second!)).toHaveLength(100);
    expect(second).not.toBe(first);
  });

  it('three files with the same declared name arrive with three distinct names', async () => {
    const { impl } = recordingFetch(okBytes('x'));
    const files = [1, 2, 3].map((n) => entry(n, { name: 'same.png' }));
    const result = await guard(fetchAttachments(files, { fetch: impl, limits: LIMITS }));
    expect(result.fetched.map((f) => f.name)).toEqual(['same.png', 'same-2.png', 'same-3.png']);
  });

  it('a skipped file does not consume a name', async () => {
    const { impl } = recordingFetch((url) => (url.includes('file-1.bin') ? new Response('x', { status: 404 }) : new Response('x', { status: 200 })));
    const files = [1, 2].map((n) => entry(n, { name: 'same.png' }));
    const result = await guard(fetchAttachments(files, { fetch: impl, limits: LIMITS }));
    expect(result.fetched.map((f) => f.name)).toEqual(['same.png']);
  });

  it('the declared mimetype never decides a name', async () => {
    const { impl } = recordingFetch(okBytes('x'));
    const result = await guard(
      fetchAttachments([entry(1, { name: undefined, mimetype: 'image/../../evil' })], { fetch: impl, limits: LIMITS }),
    );
    expect(result.fetched[0]!.name).toBe('attachment');
  });
});
