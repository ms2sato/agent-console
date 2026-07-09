import { describe, it, expect } from 'bun:test';
import {
  rewriteLocalhostHref,
  createLocalhostRewriteTransform,
} from '../localhost-rewrite';
import type { UserAccessibleLocation } from '../../../../lib/user-accessible-host';
import type { LinkRange } from '../../link-detection';

const REMOTE_HTTP: UserAccessibleLocation = { protocol: 'http:', hostname: 'console.example.com' };
const REMOTE_HTTPS: UserAccessibleLocation = { protocol: 'https:', hostname: 'console.example.com' };
const LOCAL: UserAccessibleLocation = { protocol: 'http:', hostname: 'localhost' };

describe('rewriteLocalhostHref', () => {
  it('rewrites localhost host to the remote browser host, preserving port and path', () => {
    const out = rewriteLocalhostHref('http://localhost:3000/path', REMOTE_HTTP);
    expect(out?.href).toBe('http://console.example.com:3000/path');
  });

  it('preserves the query string and fragment', () => {
    const out = rewriteLocalhostHref('https://127.0.0.1:8443/path?q=x#frag', REMOTE_HTTPS);
    expect(out?.href).toBe('https://console.example.com:8443/path?q=x#frag');
  });

  it('rewrites the 0.0.0.0 source host', () => {
    const out = rewriteLocalhostHref('http://0.0.0.0:5173/', REMOTE_HTTP);
    expect(out?.href).toBe('http://console.example.com:5173/');
  });

  it('adopts the browser scheme (http source under an https browser)', () => {
    const out = rewriteLocalhostHref('http://localhost:3000/', REMOTE_HTTPS);
    expect(out?.href).toBe('https://console.example.com:3000/');
  });

  it('returns null when the browser is itself on a loopback host', () => {
    expect(rewriteLocalhostHref('http://localhost:3000/', LOCAL)).toBeNull();
    expect(rewriteLocalhostHref('http://localhost:3000/', { protocol: 'http:', hostname: '127.0.0.1' })).toBeNull();
    expect(rewriteLocalhostHref('http://localhost:3000/', { protocol: 'http:', hostname: '::1' })).toBeNull();
    expect(rewriteLocalhostHref('http://localhost:3000/', { protocol: 'http:', hostname: '[::1]' })).toBeNull();
  });

  it('does not rewrite when the URL host is not loopback (embedded query URL is not the click target)', () => {
    // The parsed host is example.com; the localhost in the query is never the authority.
    expect(rewriteLocalhostHref('http://example.com/?redirect=http://localhost:3000', REMOTE_HTTP)).toBeNull();
  });

  it('keeps an embedded query URL verbatim when the primary host is rewritten', () => {
    const out = rewriteLocalhostHref('http://localhost:5173/login?next=http://localhost:3000/cb', REMOTE_HTTP);
    expect(out?.href).toBe('http://console.example.com:5173/login?next=http://localhost:3000/cb');
  });

  it('preserves varied ports and adds no port token when the source has none', () => {
    expect(rewriteLocalhostHref('http://localhost:8080/', REMOTE_HTTP)?.href).toBe(
      'http://console.example.com:8080/',
    );
    expect(rewriteLocalhostHref('http://localhost/', REMOTE_HTTP)?.href).toBe(
      'http://console.example.com/',
    );
  });

  it('returns null for non-loopback source hosts', () => {
    expect(rewriteLocalhostHref('http://example.org:3000/', REMOTE_HTTP)).toBeNull();
    // Exact-match only: localhost.evil.com is not loopback.
    expect(rewriteLocalhostHref('http://localhost.evil.com:3000/', REMOTE_HTTP)).toBeNull();
  });

  it('bracket-wraps an IPv6 browser hostname in the composed URL', () => {
    const out = rewriteLocalhostHref('http://localhost:3000/path', { protocol: 'http:', hostname: '2001:db8::1' });
    expect(out?.href).toBe('http://[2001:db8::1]:3000/path');
  });

  it('returns null for an unparseable URL', () => {
    expect(rewriteLocalhostHref('http://[not-a-url', REMOTE_HTTP)).toBeNull();
  });

  it('sets a title that mentions both the original and rewritten URL', () => {
    const out = rewriteLocalhostHref('http://localhost:3000/path', REMOTE_HTTP);
    expect(out?.title).toContain('http://localhost:3000/path');
    expect(out?.title).toContain('http://console.example.com:3000/path');
  });
});

describe('createLocalhostRewriteTransform', () => {
  const transform = createLocalhostRewriteTransform(REMOTE_HTTP);
  const CTX = { repoFullName: null };

  function range(href: string, start = 0, end = 10): LinkRange {
    return { start, end, href };
  }

  it('rewrites a target link, keeping the range offsets and adding a title', () => {
    const input = [range('http://localhost:3000/path', 4, 30)];
    const [out] = transform(input, CTX);
    expect(out.href).toBe('http://console.example.com:3000/path');
    expect(out.start).toBe(4);
    expect(out.end).toBe(30);
    expect(out.title).toBeDefined();
  });

  it('passes a non-target link through unchanged (same reference)', () => {
    const link = range('http://example.org:3000/');
    const input = [link];
    const [out] = transform(input, CTX);
    expect(out).toBe(link);
  });

  it('maps an empty array to an empty array', () => {
    expect(transform([], CTX)).toEqual([]);
  });
});
