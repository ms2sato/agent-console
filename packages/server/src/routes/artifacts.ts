/**
 * HTML artifact routes (HTML Artifacts phase 1).
 *
 * Mounted inside the `/api` mount (`routes/api.ts`), AFTER
 * `.use('*', authMiddleware)`, per docs/design/html-artifacts.md §4 /
 * premise P4: authentication comes ONLY from the `/api` mount, so this
 * route relies on that middleware for `authUser` rather than asserting its
 * own auth.
 *
 * Any logged-in user VIEWS an artifact (`GET /:id`, requirement 3, §4);
 * only the owner may DELETE (`DELETE /:id` below) or list (`GET /`, scoped
 * to the caller's own artifacts). This asymmetry is deliberate -- see the
 * design doc's §1 requirement 3 and §7.
 */
import { Hono } from 'hono';
import type { AppBindings } from '../app-context.js';
import { NotFoundError, ForbiddenError } from '../lib/errors.js';
import { readArtifactFile } from '../lib/artifact-storage.js';
import { consumeArtifactViewerToken } from '../lib/artifact-viewer-tokens.js';

/**
 * Response headers that reconstruct the blob-URL-equivalent boundary for a
 * server-hosted, script-executing artifact document (see
 * docs/design/html-artifacts.md §3). Combines both CSP boundary components
 * into ONE header value, semicolon-joined, in the exact order documented
 * there -- an exact-match test asserts this string byte-for-byte so any
 * future token change shows up as a loud test diff.
 *
 * §3.1 (`sandbox allow-scripts`): the `sandbox` directive in this RESPONSE
 * HEADER (not merely an iframe attribute) gives the document an opaque
 * origin even though it is served from the app's own origin -- this is
 * what protects a direct-navigation open of the URL, not just the framed
 * viewer. `allow-scripts` is present because artifact JavaScript must
 * execute (requirement 4).
 *
 * MUST NEVER add `allow-same-origin` here: combined with `allow-scripts` on
 * same-origin-served, user-authored HTML, that pairing is a full XSS of the
 * app origin. This is a permanent prohibition, not a future knob.
 *
 * P2a: do NOT append `allow-popups` or `allow-top-navigation` to the
 * sandbox token set without first re-deriving this boundary in the design
 * doc. `SameSite=Lax` (P2) blocks subresource fetches from the opaque
 * origin, but still allows top-level GET *navigations*; the omission of
 * these two tokens is what additionally blocks an artifact from
 * navigating the top-level context or opening new windows/tabs.
 *
 * §3.2 (resource CSP): no external network exists for an artifact --
 * no CDN fetch, no exfiltration target, no form POST anywhere. v1
 * artifacts are self-contained by design.
 */
export const ARTIFACT_SERVING_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'";

const artifacts = new Hono<AppBindings>()
  // List the authenticated user's own artifacts, newest first. Other users'
  // artifacts are reachable by direct URL only (GET /:id below) -- v1 has
  // no global browse (docs/design/html-artifacts.md §7).
  //
  // Optional `?sessionId=` narrows the list to artifacts originating from
  // that session. Session ownership is NOT checked -- the `authUser.id`
  // user-scope already constrains the result set, so `sessionId` is a
  // pure secondary filter, not an authorization check.
  .get('/', async (c) => {
    const { artifactRepository } = c.get('appContext');
    const authUser = c.get('authUser');
    const sessionId = c.req.query('sessionId');
    const list = sessionId
      ? await artifactRepository.findByUserIdAndSourceSessionId(authUser.id, sessionId)
      : await artifactRepository.findByUserId(authUser.id);
    return c.json({ artifacts: list });
  })
  // Serve an artifact's raw HTML bytes, byte-verbatim -- no sanitizer, no
  // parsing, no transformation anywhere in this path. Any authenticated
  // user may view any artifact (requirement 3); ownership is not checked
  // here, only on DELETE below.
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const { artifactRepository } = c.get('appContext');

    // P6' gate (docs/design/html-artifacts.md §3.3, reworked for the
    // header-blind-origin addendum): two-tier, `Sec-Fetch-Dest` first, a
    // shell-minted token as fallback ONLY when the header is entirely absent.
    //
    // P6'-a: `Sec-Fetch-Dest` is a Fetch Metadata header, and browsers
    // attach Fetch Metadata headers ONLY to requests targeting a
    // potentially-trustworthy origin (HTTPS, or localhost). On such an
    // origin, if the browser spoke, always believe it: `iframe` serves,
    // anything else (`document`, `empty`, ...) redirects to the shell. The
    // token query param is IGNORED entirely on this branch -- it is not
    // needed, the header already answered the question.
    //
    // P6'-b: when the header is ABSENT, that is NOT evidence the request
    // isn't a genuine iframe load -- it may simply be a header-blind origin
    // (plain HTTP, non-localhost, e.g. a LAN IP -- see the design doc's
    // correction trail for the reported symptom). The original
    // unconditional premise treated absence as
    // "not an iframe" and always redirected; because the viewer SHELL is
    // itself a consumer of this endpoint, that redirect fed straight back
    // into another shell render, which requested this endpoint again,
    // absent the header again -- an unbounded shell-inside-shell loop with
    // no way out. Falling back to a single-use, TTL-bound, artifact-id-bound
    // token that `routes/artifacts-viewer.ts` mints on every shell render
    // breaks that loop: a request bearing a valid, unspent token for THIS
    // artifact id is trusted as "induced by our own shell's render" and
    // served; anything else (no token, wrong id, spent, expired) redirects.
    //
    // The token is NEVER an authentication signal -- `authMiddleware`
    // (unchanged, applied via the `/api` mount) remains the sole authority
    // on WHO is asking. It proves only that a shell render induced this
    // specific request.
    const secFetchDest = c.req.header('Sec-Fetch-Dest');
    if (secFetchDest !== undefined) {
      if (secFetchDest !== 'iframe') {
        return c.redirect(`/artifacts/${encodeURIComponent(id)}`, 302);
      }
    } else {
      const viewerToken = c.req.query('vt');
      if (!viewerToken || !consumeArtifactViewerToken(viewerToken, id)) {
        return c.redirect(`/artifacts/${encodeURIComponent(id)}`, 302);
      }
    }

    const artifact = await artifactRepository.findById(id);
    if (!artifact) {
      throw new NotFoundError('Artifact');
    }

    const content = await readArtifactFile(artifact.userId, artifact.id);
    if (content === null) {
      // Row survives without its backing file (see artifact-storage.ts's
      // own JSDoc on this partially-consistent state); treat it the same
      // as "artifact not found".
      throw new NotFoundError('Artifact');
    }

    return c.body(content, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': ARTIFACT_SERVING_CSP,
      'X-Content-Type-Options': 'nosniff',
      // Required by the P6'-b token fallback: a cached raw
      // 200 could otherwise be replayed at the top level directly from the
      // browser cache, without ever passing back through this gate --
      // routing around the token's single-use property. Independently
      // correct anyway: this response is authenticated, per-user content.
      'Cache-Control': 'no-store',
    });
  })
  // Delete an artifact -- owner only. A non-owner gets 403 and the artifact
  // (row AND file) survives untouched; deleting a nonexistent id is 404.
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const { artifactRepository } = c.get('appContext');
    const authUser = c.get('authUser');

    const artifact = await artifactRepository.findById(id);
    if (!artifact) {
      throw new NotFoundError('Artifact');
    }
    if (artifact.userId !== authUser.id) {
      throw new ForbiddenError('Only the owner can delete this artifact');
    }

    const deleted = await artifactRepository.delete(id);
    if (!deleted) {
      // Deleted between the existence check and delete (race); idempotent 404.
      throw new NotFoundError('Artifact');
    }
    return c.json({ success: true });
  });

export { artifacts };
