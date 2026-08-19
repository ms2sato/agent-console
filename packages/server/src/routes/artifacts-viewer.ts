/**
 * HTML artifact viewer shell (HTML Artifacts phase 1 -- navigation-jail
 * addendum -- plus phase 2 chrome -- plus the header-blind-origin token
 * fallback).
 *
 * Mounted OUTSIDE the `/api` mount, at the top level (`GET /artifacts/:id`),
 * matching the path `mcp-server.ts`'s `buildArtifactToolResult` already
 * returns and `docs/design/html-artifacts.md` §4 already promises. Because
 * this route sits outside `/api`, it does NOT inherit `authMiddleware` for
 * free (see `docs/design/html-artifacts.md` §4 / premise P4) -- it applies
 * the middleware explicitly to the `/:id` route below (NOT to the whole
 * sub-app via `.use('*', ...)`: a bare `GET /artifacts` with no id must
 * fall through to the SPA catch-all registered later in `index.ts`, not get
 * intercepted and 401 in multi-user mode).
 *
 * This is the mandatory top-level entry point for viewing an artifact. It
 * renders a small server-rendered chrome (artifact title + owner username,
 * both HTML-escaped) above a sandboxed iframe pointed at the raw-bytes
 * endpoint (`GET /api/artifacts/:id`), and carries its own response CSP:
 *
 *   Content-Security-Policy: default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'
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
 * `style-src 'unsafe-inline'` was added in phase 2 for the chrome's own
 * `<style>` block (basic layout/typography so the title/owner line and the
 * iframe are legible). The shell still carries NO `script-src` directive
 * and no inline `<script>` -- it stays script-free; only the `style-src`
 * exception was added.
 *
 * This route validates that the artifact id exists (404s via
 * `NotFoundError` when `artifactRepository.findById` returns null), unlike
 * phase 1 where the nested iframe's own request was the only 404 check.
 * Validating here is what lets the shell render the artifact's actual
 * title/owner rather than blind placeholder chrome. `routes/artifacts.ts`
 * (raw byte-serving, `ARTIFACT_SERVING_CSP`) still owns its own gate logic
 * -- phase 2 fronts phase 1, it does not modify it. This file must NOT be
 * replaced with, or duplicated as, an SPA route at the same path, since an
 * SPA-served page cannot carry this per-route `frame-src` response header
 * the jail depends on.
 *
 * On EVERY render, this route also mints a single-use viewer token
 * (`lib/artifact-viewer-tokens.ts`) and embeds it in the iframe `src` as
 * `?vt=<token>`. This is the P6'-b fallback for a header-blind origin:
 * browsers only attach `Sec-Fetch-Dest` to requests
 * targeting a potentially-trustworthy origin (HTTPS, or localhost), so on
 * a plain-HTTP, non-localhost origin (e.g. a LAN IP), `routes/artifacts.ts`
 * cannot use the header to recognize this iframe's own genuine load. The
 * token gives it a credential it minted itself instead -- see
 * `routes/artifacts.ts`'s gate comment and docs/design/html-artifacts.md
 * §3.3 P6' for the full derivation. Minting is unconditional (no
 * origin-dependent branch here): the token is simply unused when
 * `Sec-Fetch-Dest` already answered the question.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { NotFoundError } from '../lib/errors.js';
import { mintArtifactViewerToken } from '../lib/artifact-viewer-tokens.js';

/**
 * Exact-match tested (see sibling test) so any future silent change to
 * this string shows up as a loud diff, same discipline as
 * `routes/artifacts.ts`'s `ARTIFACT_SERVING_CSP`.
 */
export const ARTIFACT_SHELL_CSP = "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'";

/**
 * HTML-escapes a value before interpolating it into the shell document --
 * used both for the iframe's `src="..."` attribute (the artifact id) and
 * for the title/owner text nodes rendered above it (the artifact's stored
 * title, an attacker-controllable string per docs/design/html-artifacts.md
 * §7, and the resolved owner username). Escaping quotes in a text-node
 * context is unnecessary but harmless -- one escape function safely covers
 * both sinks. Unlike the artifact itself, this shell page is not sandboxed
 * by anything, so an unescaped interpolation here would be a real
 * injection into the TOP-LEVEL document, not merely a jailed one.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildShellHtml(params: { artifactId: string; title: string; ownerUsername: string; viewerToken: string }): string {
  // Two nested contexts, both must be encoded, in this order: the id is a
  // URL path segment (encodeURIComponent first -- `routes/artifacts.ts`'s
  // redirect-target construction does the same), and the resulting string
  // is then interpolated into an HTML attribute (escapeHtmlAttribute
  // second). Encoding only one leaves the other unprotected -- e.g. an id
  // containing `?` would otherwise survive HTML-escaping unchanged and
  // turn `src="/api/artifacts/<id>"` into a request with a query string
  // the iframe never intended. The viewer token (a query PARAM value) gets
  // the same two-context treatment for the same reason, even though its
  // base64url alphabet is already URL-safe -- defense in depth, matching
  // the id's own discipline exactly.
  const escapedId = escapeHtmlAttribute(encodeURIComponent(params.artifactId));
  const escapedToken = escapeHtmlAttribute(encodeURIComponent(params.viewerToken));
  const escapedTitle = escapeHtmlAttribute(params.title);
  const escapedOwner = escapeHtmlAttribute(params.ownerUsername);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { padding: 0.5rem 1rem; border-bottom: 1px solid #ddd; }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem 0; }
  .owner { font-size: 0.85rem; color: #555; margin: 0; }
  iframe { flex: 1; border: 0; width: 100%; }
</style>
</head>
<body>
<header>
<h1>${escapedTitle}</h1>
<p class="owner">Created by ${escapedOwner}</p>
</header>
<iframe sandbox="allow-scripts" src="/api/artifacts/${escapedId}?vt=${escapedToken}" width="100%" height="100%" frameborder="0"></iframe>
</body>
</html>`;
}

const artifactsViewer = new Hono<AppBindings>()
  .get('/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    const { artifactRepository, userRepository } = c.get('appContext');

    const artifact = await artifactRepository.findById(id);
    if (!artifact) {
      throw new NotFoundError('Artifact');
    }

    const owner = await userRepository.findById(artifact.userId);
    const ownerUsername = owner?.username ?? 'Unknown user';

    // Minted on EVERY render, unconditionally -- no origin-dependent branch
    // here (per the Architect ruling recorded in docs/design/html-artifacts.md
    // §4). On a trustworthy origin the token is simply unused by
    // `routes/artifacts.ts`'s gate (`Sec-Fetch-Dest` wins outright there);
    // minting it anyway costs nothing and keeps this route's own logic
    // origin-agnostic, with all origin-conditionality living in one place
    // (the gate).
    const viewerToken = mintArtifactViewerToken(id);

    return c.html(
      buildShellHtml({ artifactId: id, title: artifact.title, ownerUsername, viewerToken }),
      200,
      { 'Content-Security-Policy': ARTIFACT_SHELL_CSP },
    );
  });

export { artifactsViewer };
