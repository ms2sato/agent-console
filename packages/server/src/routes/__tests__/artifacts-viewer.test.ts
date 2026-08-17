/**
 * Sibling test for the HTML artifact viewer shell (Issue #1312, HTML
 * Artifacts phase 1 -- navigation-jail addendum, `routes/artifacts-viewer.ts`).
 *
 * This route never touches `artifactRepository` (the shell does not
 * validate the artifact id exists -- see the production file's header
 * comment), so no database/filesystem fixture is needed here, unlike
 * `artifacts.test.ts`.
 *
 * The "route registration order" describe block below reads
 * `../../index.ts`'s own source text via `Bun.file()` rather than
 * `node:fs`'s `readFileSync`: `fs`/`node:fs` are memfs-mocked
 * process-globally by other test files sharing this bun:test process
 * (`.claude/rules/testing.md` Anti-Pattern #2), and a memfs volume has no
 * knowledge of this repository's real `index.ts` -- `readFileSync` would
 * throw ENOENT there even though the real file exists on disk. `Bun.file`
 * is Bun-native and bypasses that interception, matching the same pattern
 * `lib/artifact-storage.ts` uses for the same reason.
 */
import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import type { AuthUser } from '@agent-console/shared';
import { artifactsViewer, ARTIFACT_SHELL_CSP } from '../artifacts-viewer.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';

const OWNER: AuthUser = { id: 'owner-1', username: 'owner', homeDir: '/home/owner' };

function mockUserMode(authenticateResult: AuthUser | null): UserMode {
  return {
    authenticate: () => authenticateResult,
    login: async () => null,
    spawnPty: (_request: PtySpawnRequest): PtyInstance => {
      throw new Error('spawnPty not implemented in mock');
    },
  };
}

/**
 * Builds a Hono app that mirrors production layering for `/artifacts`:
 * appContext -> the route's OWN authMiddleware (it doesn't inherit `/api`'s,
 * per P4) -> route. `authenticateResult` controls whether the simulated
 * request is authenticated.
 */
function buildApp(authenticateResult: AuthUser | null): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    userMode: mockUserMode(authenticateResult),
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.onError(onApiError);
  app.route('/artifacts', artifactsViewer);
  return app;
}

describe('Artifact viewer shell route', () => {
  describe('ARTIFACT_SHELL_CSP', () => {
    it('is the exact fixed string from docs/design/html-artifacts.md §3', () => {
      expect(ARTIFACT_SHELL_CSP).toBe("default-src 'none'; frame-src 'self'");
    });
  });

  describe('GET /artifacts/:id', () => {
    it('returns the shell HTML with the exact CSP header for an authenticated request', async () => {
      const app = buildApp(OWNER);
      const res = await app.request('/artifacts/some-id');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_SHELL_CSP);
      expect(res.headers.get('Content-Type')).toContain('text/html');

      const body = await res.text();
      expect(body).toContain('<iframe sandbox="allow-scripts" src="/api/artifacts/some-id"');
    });

    it('rejects an unauthenticated request with 401 (this route does not inherit /api auth)', async () => {
      const app = buildApp(null);
      const res = await app.request('/artifacts/some-id');
      expect(res.status).toBe(401);
    });

    it('does NOT validate that the artifact id exists -- the nested iframe is responsible for its own 404', async () => {
      // No artifactRepository is even present in this test's appContext;
      // if the route touched it, this request would throw rather than
      // return 200.
      const app = buildApp(OWNER);
      const res = await app.request('/artifacts/definitely-does-not-exist');
      expect(res.status).toBe(200);
    });

    it('percent-encodes then HTML-attribute-escapes an artifact id containing quote/markup characters before interpolating it into the iframe src', async () => {
      const maliciousId = '"><script>alert(1)</script><iframe src="';
      const app = buildApp(OWNER);
      const res = await app.request(`/artifacts/${encodeURIComponent(maliciousId)}`);

      expect(res.status).toBe(200);
      const body = await res.text();

      // The raw payload must never appear unescaped -- if it did, the
      // attribute would be broken out of and new markup injected into this
      // UNSANDBOXED top-level document.
      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).not.toContain('"><script>');
      // encodeURIComponent runs first (the id is also a URL path segment --
      // routes/artifacts.ts's redirect-target construction does the same),
      // so every HTML-meaningful character is already percent-encoded by
      // the time escapeHtmlAttribute would otherwise act on it. The
      // percent-encoded form is what must appear in the iframe src.
      expect(body).toContain(
        '<iframe sandbox="allow-scripts" src="/api/artifacts/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3Ciframe%20src%3D%22"',
      );
    });
  });

  // ===========================================================================
  // Route registration order (index.ts) -- catches a future accidental
  // reordering that would silently shadow the shell behind the SPA
  // catch-all in production. Two complementary checks:
  //  1. A routing-PRECEDENCE proof, using the REAL production
  //     `artifactsViewer` router mounted alongside a synthetic SPA-shaped
  //     catch-all, in BOTH orders -- demonstrating Hono's actual
  //     first-registered-wins behavior (so this test would catch the
  //     mechanism regressing, not just assert it as given).
  //  2. A source-order check directly against `index.ts`'s own file
  //     content -- the thing that would actually catch a future accidental
  //     reorder of the real registration calls.
  // ===========================================================================
  describe('route registration order', () => {
    function buildAppWithOrder(order: 'shell-first' | 'catch-all-first'): Hono<AppBindings> {
      const partialContext: Partial<AppContext> = { userMode: mockUserMode(OWNER) };
      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', partialContext as AppContext);
        await next();
      });
      app.onError(onApiError);

      const registerShell = () => app.route('/artifacts', artifactsViewer);
      // Mirrors index.ts's production SPA fallback shape: `app.get('*', ...)`.
      const registerCatchAll = () => app.get('*', (c) => c.html('<html>SPA index.html</html>'));

      if (order === 'shell-first') {
        registerShell();
        registerCatchAll();
      } else {
        registerCatchAll();
        registerShell();
      }
      return app;
    }

    it('shell wins when registered BEFORE the SPA catch-all (matches production index.ts order)', async () => {
      const app = buildAppWithOrder('shell-first');
      const res = await app.request('/artifacts/some-id');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_SHELL_CSP);
      const body = await res.text();
      expect(body).toContain('<iframe sandbox="allow-scripts"');
    });

    it('SPA catch-all wins when registered BEFORE the shell (proves this test has real polarity, i.e. it would fail on an accidental reorder)', async () => {
      const app = buildAppWithOrder('catch-all-first');
      const res = await app.request('/artifacts/some-id');
      expect(res.status).toBe(200);
      // The wrong order shadows the jail shell entirely -- no CSP, no iframe.
      expect(res.headers.get('Content-Security-Policy')).not.toBe(ARTIFACT_SHELL_CSP);
      const body = await res.text();
      expect(body).toBe('<html>SPA index.html</html>');
    });

    it("index.ts registers the artifact viewer shell BEFORE the SPA catch-all", async () => {
      const indexTsPath = path.join(import.meta.dir, '../../index.ts');
      const source = await Bun.file(indexTsPath).text();

      const shellRegistrationIndex = source.indexOf("app.route('/artifacts', artifactsViewer);");
      const spaCatchAllIndex = source.indexOf("app.get('*', (c) => {");

      expect(shellRegistrationIndex).toBeGreaterThan(-1);
      expect(spaCatchAllIndex).toBeGreaterThan(-1);
      expect(shellRegistrationIndex).toBeLessThan(spaCatchAllIndex);
    });
  });
});
