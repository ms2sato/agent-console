import { describe, it, expect } from 'bun:test';
import { linkHost } from '../link-host';

describe('linkHost', () => {
  it('returns the host (with port) of an absolute URL', () => {
    expect(linkHost('https://example.com/a/b?q=1')).toBe('example.com');
    expect(linkHost('http://localhost:3457/x')).toBe('localhost:3457');
  });

  it('renders a confusable Unicode host in its Punycode form (homograph pin)', () => {
    // Cyrillic small a (U+0430) in place of the Latin a.
    expect(linkHost('https://аpple.example/')).toBe('xn--pple-43d.example'); // lang-check:allow
  });

  it('falls back to the input when it does not parse as a URL', () => {
    expect(linkHost('not a url')).toBe('not a url');
    expect(linkHost('')).toBe('');
  });
});
