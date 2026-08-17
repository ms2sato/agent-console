/**
 * HTML artifact viewer shell (HTML Artifacts phase 1 -- navigation-jail
 * addendum).
 *
 * Mounted OUTSIDE the `/api` mount, at the top level (`GET /artifacts/:id`),
 * matching the path `mcp-server.ts`'s `buildArtifactToolResult` already
 * returns and `docs/design/html-artifacts.md` §4 already promises. Because
 * this route sits outside `/api`, it does NOT inherit `authMiddleware` for
 * free (see `docs/design/html-artifacts.md` §4 / premise P4) -- it applies
 * the middleware explicitly below.
 *
 * This is the mandatory top-level entry point for viewing an artifact. It
 * renders nothing but a sandboxed iframe pointed at the raw-bytes endpoint
 * (`GET /api/artifacts/:id`) and carries its own response CSP:
 *
 *   Content-Security-Policy: default-src 'none'; frame-src 'self'
 *
 * `frame-src 'self'` is the mechanism that closes the self-navigation
 * exfiltration hole a sandboxed-but-scriptable artifact would otherwise
 * have: a child browsing context's navigations -- INCLUDING navigations the
 * child initiates on ITSELF (`window.location = 'https://evil...'`) -- are
 * checked against the EMBEDDING document's `frame-src`, not just against
 * the artifact's own CSP (which has no `sandbox` token or CSP directive
 * that stops a same-context self-navigation). See
 * docs/design/html-artifacts.md §3.3 P7. `default-src 'none'` covers every
 * other resource type this shell itself might otherwise fetch; it fetches
 * nothing, so the fallback is simply "nothing else is allowed".
 *
 * The shell intentionally carries NO inline `style` attribute/block: adding
 * one would require `style-src 'unsafe-inline'` in the CSP above, which is
 * unnecessary surface for a two-line wrapper page. Layout is done via the
 * iframe's own `width`/`height` HTML attributes (not CSS), which CSP's
 * `style-src` does not govern.
 *
 * This route does NOT validate that the artifact id exists -- that is the
 * nested iframe's problem (its own request to `GET /api/artifacts/:id`
 * 404s independently), the same way a plain `<img src>` wrapper page does
 * not pre-check the image exists. Phase 2 (#1313) owns styling/enriching
 * this shell and a separate history page; it must NOT replace this
 * server-rendered route with an SPA route at the same path, since an
 * SPA-served page cannot carry this per-route `frame-src` response header
 * the jail depends on.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Exact-match tested (see sibling test) so any future silent change to
 * this string shows up as a loud diff, same discipline as
 * `routes/artifacts.ts`'s `ARTIFACT_SERVING_CSP`.
 */
export const ARTIFACT_SHELL_CSP = "default-src 'none'; frame-src 'self'";

/**
 * HTML-attribute-escapes the artifact id before interpolating it into the
 * iframe's `src="..."` attribute. The id is an attacker-controllable URL
 * path segment (this route never validates it against the repository), so
 * an unescaped id could break out of the attribute and inject markup into
 * this TOP-LEVEL document -- unlike the artifact itself, this shell page is
 * not sandboxed by anything, so that would be a real injection, not merely
 * a jailed one.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildShellHtml(artifactId: string): string {
  // Two nested contexts, both must be encoded, in this order: the id is a
  // URL path segment (encodeURIComponent first -- `routes/artifacts.ts`'s
  // redirect-target construction does the same), and the resulting string
  // is then interpolated into an HTML attribute (escapeHtmlAttribute
  // second). Encoding only one leaves the other unprotected -- e.g. an id
  // containing `?` would otherwise survive HTML-escaping unchanged and
  // turn `src="/api/artifacts/<id>"` into a request with a query string
  // the iframe never intended.
  const escapedId = escapeHtmlAttribute(encodeURIComponent(artifactId));
  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<iframe sandbox="allow-scripts" src="/api/artifacts/${escapedId}" width="100%" height="100%" frameborder="0"></iframe>
</body>
</html>`;
}

const artifactsViewer = new Hono<AppBindings>()
  .use('*', authMiddleware)
  .get('/:id', (c) => {
    const id = c.req.param('id');
    return c.html(buildShellHtml(id), 200, {
      'Content-Security-Policy': ARTIFACT_SHELL_CSP,
    });
  });

export { artifactsViewer };
