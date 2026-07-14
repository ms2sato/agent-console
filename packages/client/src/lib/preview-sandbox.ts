/**
 * Sanitization + document assembly for the sandboxed HTML/SVG preview
 * feature. These are pure functions (no React) so they are
 * independently unit-testable, and no part of the sanitizer relies on
 * regex-based HTML parsing -- regex cannot reliably parse HTML/SVG and is
 * explicitly prohibited for this purpose. `DOMParser` parses untrusted input
 * into an inert document (scripts do not execute, resources are not
 * fetched), which is what makes it safe to run over AI-generated content.
 *
 * This is a defense-in-depth layer, not the only one: the resulting
 * document is also rendered inside an `<iframe sandbox="">` (see
 * PreviewPanel.tsx) with a restrictive CSP. Security-critical: do not change
 * the sandbox attribute, the CSP string, or this sanitizer approach without
 * an explicit architect review.
 */

/**
 * CSP applied to every preview document via a `<meta http-equiv>` tag.
 * `default-src 'none'` blocks all network/script access; `style-src
 * 'unsafe-inline'` allows the inline `<style>` blocks AI-generated markup
 * commonly uses; `img-src data:` allows inline data-URI images without
 * allowing any other network fetch.
 */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Matches a `javascript:` URL after whitespace/control-character stripping and lowercasing. */
const JAVASCRIPT_URL_PATTERN = /^javascript:/;
/** Whitespace and C0 control characters, stripped before the `javascript:` check to defeat evasion (e.g. `"java\nscript:alert(1)"`). */
const WHITESPACE_AND_CONTROL_CHARS_PATTERN = /[\s\x00-\x1f]/g;

/**
 * Removes `<script>` elements, `on*` attributes, and `javascript:` URLs from
 * an HTML/SVG fragment. Returns the sanitized fragment's inner HTML (not a
 * full document).
 *
 * Does NOT strip `<style>` elements -- CSS is core to the preview and must
 * survive; this is why `rehype-sanitize`'s schema (which drops `<style>`)
 * was rejected for this job in favor of a purpose-built sanitizer.
 */
export function sanitizePreviewFragment(fragment: string): string {
  const doc = new DOMParser().parseFromString(fragment, 'text/html');

  // querySelectorAll('script') matches by local name regardless of
  // namespace, so this also removes <script> elements nested inside an
  // inline <svg>.
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    script.remove();
  }

  // document.querySelectorAll('*') includes the root <html> element itself
  // plus every descendant (<head>, <body>, and all nested elements), so a
  // single pass covers the whole document.
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
      const normalizedValue = attr.value.replace(WHITESPACE_AND_CONTROL_CHARS_PATTERN, '').toLowerCase();
      if (JAVASCRIPT_URL_PATTERN.test(normalizedValue)) {
        element.removeAttribute(attr.name);
      }
    }
  }

  // A full-document input (`<!DOCTYPE html><html><head>...`) places any
  // <style> found before/in <head> into doc.head, not doc.body -- returning
  // only doc.body.innerHTML would silently drop that CSS. <link>/<meta>/etc.
  // in <head> are discarded: external <link> fetches are already blocked by
  // the CSP (`default-src 'none'`), so only <style> is worth preserving.
  const headStyles = Array.from(doc.head.querySelectorAll('style'))
    .map((style) => style.outerHTML)
    .join('');
  return headStyles + doc.body.innerHTML;
}

/** Wraps a sanitized fragment in a full HTML document with the preview CSP meta tag. */
export function buildPreviewDocument(sanitizedFragment: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
</head>
<body>${sanitizedFragment}</body>
</html>`;
}

/**
 * Sanitizes + wraps `code` and creates a `blob:` URL for the resulting
 * document. Caller must `URL.revokeObjectURL` the returned URL once it is no
 * longer needed (see PreviewPanel.tsx's effect cleanup).
 */
export function createPreviewBlobUrl(code: string): string {
  const sanitized = sanitizePreviewFragment(code);
  const document = buildPreviewDocument(sanitized);
  const blob = new Blob([document], { type: 'text/html' });
  return URL.createObjectURL(blob);
}
