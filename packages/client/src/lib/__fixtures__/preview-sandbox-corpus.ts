/**
 * Shared mXSS regression corpus for the embedded-agent HTML/SVG preview
 * sanitizer (`../preview-sandbox.ts`). Single source of truth for two
 * independent consumers so they cannot drift apart:
 *
 *   - `../__tests__/preview-sandbox.test.ts` (bun:test / happy-dom) --
 *     exercises the parser-independent neutralization vectors.
 *   - `scripts/run-preview-sandbox-browser-check.mjs` (real Chromium via
 *     Playwright) -- exercises the same vectors against a real browser
 *     engine, plus the production `<iframe sandbox="">` containment
 *     composition.
 *
 * This file holds only vector data (test fixtures), not sanitizer logic or
 * assertions -- each consumer owns its own assertion shape.
 */

export interface CorpusVector {
  /** Short human-readable description, used in test names / report lines. */
  name: string;
  /** The raw, untrusted HTML/SVG fragment to sanitize. */
  vector: string;
}

/**
 * Vectors whose safety does NOT depend on HTML5 foreign-content/RAWTEXT/
 * adoption-agency parser edge cases -- i.e. the dangerous construct becomes a
 * real, unambiguous DOM node/attribute on the FIRST parse in any conforming
 * engine, so the sanitizer's namespace-agnostic tree walk (querySelectorAll
 * by tag name, generic attribute iteration) is what's actually exercised.
 * Expected to be fully neutralized (no surviving <script>, no surviving on*
 * attribute) after a sanitize -> re-parse cycle, in ANY conforming HTML
 * parser -- including both happy-dom and real Chromium.
 */
export const NEUTRALIZED_VECTORS: CorpusVector[] = [
  {
    name: 'on* attribute on a MathML element (namespace-agnostic attribute removal)',
    vector: '<math><mi onclick="alert(1)">x</mi></math>',
  },
  {
    name: '<script> element nested inside MathML (namespace-agnostic tag removal)',
    vector: '<math><mtext><script>alert(1)</script></mtext></math>',
  },
  {
    name: 'on* attribute directly on <noscript>',
    vector: '<noscript onclick="alert(1)">text</noscript>',
  },
  {
    name: '<script> element whose content uses an HTML-comment decoy',
    vector: '<script><!--alert(1)--></script>',
  },
  {
    name: 'javascript: URL on xlink:href nested inside <svg><a>, case-varied',
    vector: '<svg><a xlink:href="JavaScript:alert(1)"><text>click</text></a></svg>',
  },
];

/**
 * Known, currently-unresolved parser-quirk-dependent mXSS gap: the classic
 * cure53 adoption-agency-triggering shape. Survives the sanitizer's first
 * `DOMParser` pass as inert RAWTEXT content inside `<style>`, then
 * reconstitutes a real `<img onerror>` element on re-parse in engines that
 * implement the HTML5 foreign-content/adoption-agency algorithm (confirmed
 * in real Chromium; happy-dom does not reproduce this -- see
 * `../__tests__/preview-sandbox.test.ts`). Production containment (the
 * `<iframe sandbox="">` + CSP composition in `PreviewPanel.tsx`) holds
 * regardless of this sanitizer-level gap -- verified by the real-Chromium
 * runner, not by this fixture.
 *
 * NOT included in `NEUTRALIZED_VECTORS`: this vector's sanitizer-level
 * neutralization is a known, tracked non-goal for now (deferred tokenizer /
 * allowlist redesign; see the tracking issue referenced in this vector's
 * `name` field below). Consumers must treat any "does this survive sanitize
 * -> re-parse" assertion on this vector as informational, not a blocking
 * regression gate -- asserting it as a hard failure would go red the moment
 * a future sanitizer improvement neutralizes it, punishing progress (see the
 * containment-invariant test in `../__tests__/preview-sandbox.test.ts` for
 * the established rationale).
 */
export const KNOWN_GAP_VECTOR: CorpusVector = {
  name: 'cure53 adoption-agency shape (Issue #1162, known gap, containment-only)',
  vector: '<form><math><mtext></form><form><mglyph><style></math><img src=1 onerror=alert(1)>',
};
