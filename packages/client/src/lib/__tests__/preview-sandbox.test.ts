import { describe, it, expect } from 'bun:test';
import { PREVIEW_CSP, sanitizePreviewFragment, buildPreviewDocument } from '../preview-sandbox';
import { NEUTRALIZED_VECTORS, KNOWN_GAP_VECTOR } from '../__fixtures__/preview-sandbox-corpus';

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

  it('preserves <style> content from a full-document input where DOMParser places <style> in <head>', () => {
    // Full-document input (DOCTYPE + <html><head>...</head><body>...</body></html>)
    // is the LLM's most common output shape for HTML previews. DOMParser
    // places a <style> found in an explicit <head> into doc.head, not
    // doc.body -- unlike the body-only fragment in the "preserves <style>
    // content" test above, which the parser places directly into doc.body
    // since no <head>/<body> tags are present in that input. Both must
    // survive sanitization.
    const result = sanitizePreviewFragment(
      '<!DOCTYPE html><html><head><style>.box { color: red; }</style></head><body><div class="box">hi</div></body></html>',
    );
    expect(result).toContain('.box { color: red; }');
    expect(result).toContain('<div class="box">hi</div>');
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

describe('mXSS regression corpus', () => {
  // These vectors probe namespace-mixing (SVG/MathML) and RAWTEXT/comment
  // edge cases -- the parsing shapes that mutation-XSS (mXSS) research
  // targets. Each assertion re-parses the sanitizer's OWN first-pass output
  // (simulating the real second parse that happens when PreviewPanel's
  // iframe loads the wrapped document from its blob: URL) and checks for
  // survivors, not just "no crash" -- this is the polarity check, not a
  // weak string match.
  //
  // Scope note: this corpus intentionally only covers vectors whose safety
  // does NOT depend on HTML5 foreign-content/RAWTEXT/adoption-agency parser
  // edge cases -- i.e. cases where the dangerous construct becomes a real,
  // unambiguous DOM node/attribute on the FIRST parse in any conforming
  // engine, so the sanitizer's namespace-agnostic tree walk (querySelectorAll
  // by tag name, generic attribute iteration) is what's actually being
  // exercised. Vectors that rely on a browser engine's *specific* foreign-
  // content parsing behavior (namespace-confusion mutation vectors such as
  // the classic cure53 `<form><math><mtext></form><form><mglyph><style>...`
  // shape) are deliberately NOT encoded here: this repo's test environment
  // (happy-dom, see `packages/client/src/test/setup.ts`) does not
  // faithfully reproduce Chromium's HTML5 tree-construction algorithm for
  // these edge cases (confirmed empirically -- happy-dom silently drops
  // content in several of these shapes that real Chromium preserves, and
  // vice versa). A bun:test assertion built on those vectors would pin
  // happy-dom's parser, not Chromium's, which would misrepresent what's
  // actually being verified. Those vectors are instead empirically verified
  // against real Chromium (Chrome DevTools MCP) and recorded as evidence in
  // the PR body for Issue #1106, with the known non-neutralized case
  // tracked in Issue #1162. Automated regression coverage for that class of
  // vector (real-browser parsing behavior) lives in
  // scripts/run-preview-sandbox-browser-check.mjs, not in this bun:test file.
  function assertFullyNeutralizedAcrossReparse(vector: string) {
    const firstPass = sanitizePreviewFragment(vector);
    // Re-parse the sanitizer's own output, simulating the iframe's real
    // second parse of the blob: URL document.
    const reparsed = new DOMParser().parseFromString(firstPass, 'text/html');
    const hasScript = reparsed.querySelectorAll('script').length > 0;
    const hasOnAttr = Array.from(reparsed.querySelectorAll('*')).some((el) =>
      Array.from(el.attributes).some((attr) => attr.name.toLowerCase().startsWith('on')),
    );
    expect(hasScript).toBe(false);
    expect(hasOnAttr).toBe(false);
  }

  // Vectors are sourced from the shared corpus fixture (../__fixtures__/preview-sandbox-corpus.ts),
  // which is also consumed by scripts/run-preview-sandbox-browser-check.mjs (real Chromium) --
  // see Issue #1162. Do not inline vectors here; add new ones to the fixture instead.
  for (const { name, vector } of NEUTRALIZED_VECTORS) {
    it(`neutralizes: ${name}`, () => {
      assertFullyNeutralizedAcrossReparse(vector);
    });
  }

  it(
    'containment invariant (Issue #1162): the CSP applied to every preview document is exact and ' +
      'unweakened regardless of sanitizer input -- this is what actually contains a known, currently ' +
      'unresolved sanitizer gap (a parser-quirk-dependent mXSS shape verified empirically against real ' +
      'Chromium; see Issue #1162 and the PR body for the vector and the empirical evidence). This test ' +
      'intentionally does NOT assert anything about sanitizer output for that vector -- doing so would ' +
      'go red the moment a future sanitizer improvement neutralizes it, punishing progress. It asserts ' +
      'the containment property instead: buildPreviewDocument always emits the exact, unweakened CSP ' +
      'string, correctly scoped inside <head> before <body>, regardless of what the sanitizer did or did ' +
      'not neutralize. (The second engine-independent containment layer, the iframe\'s sandbox="" attribute ' +
      'with no allow-scripts token, is set in PreviewPanel.tsx and is covered by PreviewPanel.test.tsx\'s ' +
      'existing sandbox="" assertion -- not re-tested here since this file only covers preview-sandbox.ts\'s ' +
      'own exports.)',
    () => {
      // Representative of the known-gap shape (Issue #1162) -- its exact
      // sanitizer output is irrelevant to this assertion; see comment above.
      // Sourced from the shared corpus fixture (see the import at top of file).
      const sanitized = sanitizePreviewFragment(KNOWN_GAP_VECTOR.vector);
      const doc = buildPreviewDocument(sanitized);

      const cspMetaTags = Array.from(
        doc.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)">/gi),
      );
      expect(cspMetaTags).toHaveLength(1);
      expect(cspMetaTags[0][1]).toBe(PREVIEW_CSP);

      const headIndex = doc.indexOf('<head>');
      const cspIndex = doc.indexOf('<meta http-equiv="Content-Security-Policy"');
      const bodyIndex = doc.indexOf('<body>');
      expect(headIndex).toBeGreaterThanOrEqual(0);
      expect(cspIndex).toBeGreaterThan(headIndex);
      expect(bodyIndex).toBeGreaterThan(cspIndex);
    },
  );
});
