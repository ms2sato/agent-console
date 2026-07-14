import { describe, it, expect } from 'bun:test';
import { PREVIEW_CSP, sanitizePreviewFragment, buildPreviewDocument } from '../preview-sandbox';

describe('sanitizePreviewFragment', () => {
  it('removes <script> elements', () => {
    const result = sanitizePreviewFragment('<div>before</div><script>alert(1)</script><div>after</div>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert(1)');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('removes <script> elements nested inside an inline <svg>', () => {
    // NOTE: happy-dom's DOMParser (test environment only) drops SVG
    // sibling content that follows a <script> in source order -- a known
    // happy-dom foreign-content parsing quirk unrelated to this sanitizer,
    // which operates purely via querySelectorAll('script') + remove() after
    // parsing. Ordering <circle> before <script> avoids tripping that
    // parser quirk while still exercising script removal inside <svg>.
    const result = sanitizePreviewFragment('<svg><circle r="1"></circle><script>alert(1)</script></svg>');
    expect(result).not.toContain('<script');
    expect(result).toContain('circle');
  });

  it('removes onclick/onerror/on* attributes generically, without an enumerated allowlist', () => {
    const result = sanitizePreviewFragment(
      '<button onclick="alert(1)">click</button><img onerror="alert(2)" src="x.png"><div oncustomthing="alert(3)">x</div>',
    );
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('oncustomthing');
    expect(result).not.toContain('alert');
  });

  it('preserves non-"on"-prefixed attributes', () => {
    const result = sanitizePreviewFragment('<div class="box" data-foo="bar">hi</div>');
    expect(result).toContain('class="box"');
    expect(result).toContain('data-foo="bar"');
  });

  it('removes javascript: URLs from href', () => {
    const result = sanitizePreviewFragment('<a href="javascript:alert(1)">link</a>');
    expect(result).not.toContain('javascript:');
  });

  it('removes javascript: URLs from arbitrary attributes (xlink:href, formaction, etc.), not just href/src', () => {
    const result = sanitizePreviewFragment(
      '<svg><use xlink:href="javascript:alert(1)"></use></svg><form><button formaction="javascript:alert(2)">go</button></form>',
    );
    expect(result).not.toContain('javascript:');
  });

  it('removes javascript: URLs using a whitespace-evasion payload (e.g. "java\\nscript:alert(1)")', () => {
    const result = sanitizePreviewFragment('<a href="java\nscript:alert(1)">link</a>');
    expect(result).not.toMatch(/href\s*=/);
    expect(result).not.toContain('alert(1)');
  });

  it('removes javascript: URLs regardless of case', () => {
    const result = sanitizePreviewFragment('<a href="JavaScript:alert(1)">link</a>');
    expect(result).not.toMatch(/href\s*=/i);
  });

  it('preserves <style> content', () => {
    const result = sanitizePreviewFragment('<style>.box { color: red; }</style><div class="box">hi</div>');
    expect(result).toContain('<style>');
    expect(result).toContain('.box { color: red; }');
  });

  it('preserves ordinary safe markup unchanged in structure', () => {
    const result = sanitizePreviewFragment('<div><p>Hello <strong>world</strong></p></div>');
    expect(result).toContain('<p>Hello <strong>world</strong></p>');
  });
});

describe('buildPreviewDocument', () => {
  it('produces the exact CSP meta content string, verbatim', () => {
    const doc = buildPreviewDocument('<div>hi</div>');
    expect(doc).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(doc).toContain(`content="${PREVIEW_CSP}"`);
  });

  it('embeds the sanitized fragment in the document body', () => {
    const doc = buildPreviewDocument('<div id="marker">hi</div>');
    expect(doc).toContain('<div id="marker">hi</div>');
  });

  it('includes a charset meta tag', () => {
    const doc = buildPreviewDocument('<div>hi</div>');
    expect(doc).toContain('<meta charset="utf-8">');
  });
});
