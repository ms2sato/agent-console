/**
 * Sibling test for the HTML artifact viewer shell (Issue #1312 phase 1 +
 * Issue #1313 phase 2 chrome, `routes/artifacts-viewer.ts`).
 *
 * Built on top of the REAL `SqliteArtifactRepository` + `SqliteUserRepository`
 * (real in-memory sqlite db), mirroring `artifacts.test.ts`'s pattern: the
 * shell now resolves both the artifact and its owning user, so a
 * mock-only `appContext` (phase 1's approach) can no longer exercise it.
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
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { sql, type Kysely } from 'kysely';
import type { AuthUser } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { SqliteUserRepository } from '../../repositories/sqlite-user-repository.js';
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

describe('Artifact viewer shell route', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let db: Kysely<Database>;
  let artifactRepository: SqliteArtifactRepository;
  let userRepository: SqliteUserRepository;

  beforeEach(async () => {
    process.env.AGENT_CONSOLE_HOME = path.join(os.tmpdir(), `agent-console-artifact-viewer-test-${randomUUID()}`);
    db = await createDatabaseForTest();
    artifactRepository = new SqliteArtifactRepository(db);
    userRepository = new SqliteUserRepository(db);

    // `artifacts.user_id` carries a real FK to `users.id` -- seed the test
    // user this file's tests attribute artifacts to.
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: OWNER.id, os_uid: null, username: OWNER.username, home_dir: OWNER.homeDir, created_at: now, updated_at: now })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  /**
   * Builds a Hono app that mirrors production layering for `/artifacts`:
   * appContext -> the route's OWN authMiddleware, scoped to `/:id` (it
   * doesn't inherit `/api`'s, per P4) -> route. `authenticateResult`
   * controls whether the simulated request is authenticated.
   */
  function buildApp(authenticateResult: AuthUser | null): Hono<AppBindings> {
    const partialContext: Partial<AppContext> = {
      artifactRepository,
      userRepository,
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

  describe('ARTIFACT_SHELL_CSP', () => {
    it('is the exact fixed string from docs/design/html-artifacts.md §3', () => {
      expect(ARTIFACT_SHELL_CSP).toBe("default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'");
    });

    it('retains the load-bearing frame-src and default-src tokens', () => {
      expect(ARTIFACT_SHELL_CSP).toContain("frame-src 'self'");
      expect(ARTIFACT_SHELL_CSP).toContain("default-src 'none'");
    });
  });

  describe('GET /artifacts/:id', () => {
    it('returns the shell HTML with the exact CSP header, chrome, and iframe for an authenticated request', async () => {
      const created = await artifactRepository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'My Artifact',
        content: '<p>hi</p>',
        sourceSessionId: null,
      });

      const app = buildApp(OWNER);
      const res = await app.request(`/artifacts/${created.id}`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_SHELL_CSP);
      expect(res.headers.get('Content-Type')).toContain('text/html');

      const body = await res.text();
      expect(body).toContain('My Artifact');
      expect(body).toContain('Created by owner');
      expect(body).toContain(`<iframe sandbox="allow-scripts" src="/api/artifacts/${created.id}"`);
    });

    it('rejects an unauthenticated request with 401 (this route does not inherit /api auth)', async () => {
      const created = await artifactRepository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(null);
      const res = await app.request(`/artifacts/${created.id}`);
      expect(res.status).toBe(401);
    });

    it('returns 404 for a nonexistent artifact id (the shell now validates existence)', async () => {
      const app = buildApp(OWNER);
      const res = await app.request('/artifacts/definitely-does-not-exist');
      expect(res.status).toBe(404);
    });

    it('renders "Unknown user" when the owning user row cannot be resolved, without throwing', async () => {
      // `artifacts.user_id` carries a real FK (ON DELETE CASCADE) to
      // `users.id`, so this partially-consistent state (an artifact row
      // whose owning user no longer exists) cannot arise through the
      // repository's own `create`/`delete` methods in this schema -- it is
      // constructed here directly at the DB layer, with FK enforcement
      // temporarily suspended for the single insert, purely to exercise the
      // shell's defensive fallback.
      const artifactId = randomUUID();
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      await db
        .insertInto('artifacts')
        .values({
          id: artifactId,
          user_id: 'a-user-id-with-no-row',
          title: 'Orphaned artifact',
          created_at: new Date().toISOString(),
          size_bytes: 0,
          source_session_id: null,
        })
        .execute();
      await sql`PRAGMA foreign_keys = ON`.execute(db);

      const app = buildApp(OWNER);
      const res = await app.request(`/artifacts/${artifactId}`);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Created by Unknown user');
    });

    it('HTML-escapes an artifact title containing a live <script> tag (T1a, must fail against an unescaped implementation)', async () => {
      // Inserted DIRECTLY at the repository layer to bypass any write-time
      // title-stripping elsewhere -- the raw unstripped value is what must
      // be escaped at render time.
      const created = await artifactRepository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'Evil <script>alert(1)</script>',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(OWNER);
      const res = await app.request(`/artifacts/${created.id}`);
      expect(res.status).toBe(200);

      const body = await res.text();
      expect(body).toContain('Evil &lt;script&gt;alert(1)&lt;/script&gt;');
      expect(body).not.toContain('<script>alert(1)</script>');
    });

    it('percent-encodes then HTML-attribute-escapes an artifact id containing quote/markup characters before interpolating it into the iframe src', async () => {
      const maliciousId = '"><script>alert(1)</script><iframe src="';
      const app = buildApp(OWNER);
      const res = await app.request(`/artifacts/${encodeURIComponent(maliciousId)}`);

      // The id doesn't resolve to a real artifact, so this now 404s before
      // ever reaching buildShellHtml -- confirming the raw payload never
      // reaches ANY response body, escaped or not, is still meaningful.
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).not.toContain('"><script>');
    });
  });

  // ===========================================================================
  // Auth scoping (S1) -- the shell's authMiddleware is scoped to `/:id`
  // only, so a bare `GET /artifacts` (no id) falls through to whatever is
  // registered after it (the SPA catch-all in production), rather than
  // being intercepted and 401'd.
  // ===========================================================================
  describe('auth scoping (S1) -- bare GET /artifacts falls through, not intercepted', () => {
    function buildAppWithCatchAll(authenticateResult: AuthUser | null): Hono<AppBindings> {
      const partialContext: Partial<AppContext> = {
        artifactRepository,
        userRepository,
        userMode: mockUserMode(authenticateResult),
      };
      const app = new Hono<AppBindings>();
      app.use('*', async (c, next) => {
        c.set('appContext', partialContext as AppContext);
        await next();
      });
      app.onError(onApiError);
      app.route('/artifacts', artifactsViewer);
      // Mirrors index.ts's production SPA fallback shape: `app.get('*', ...)`.
      app.get('*', (c) => c.html('<html>SPA index.html</html>'));
      return app;
    }

    it('bare GET /artifacts hits the SPA catch-all for an AUTHENTICATED simulated request', async () => {
      const app = buildAppWithCatchAll(OWNER);
      const res = await app.request('/artifacts');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).not.toBe(ARTIFACT_SHELL_CSP);
      expect(await res.text()).toBe('<html>SPA index.html</html>');
    });

    it('bare GET /artifacts hits the SPA catch-all for an UNAUTHENTICATED simulated request (not a 401)', async () => {
      const app = buildAppWithCatchAll(null);
      const res = await app.request('/artifacts');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>SPA index.html</html>');
    });

    it('GET /artifacts/:id is still gated by auth (the scoped middleware still applies to the :id route)', async () => {
      const app = buildAppWithCatchAll(null);
      const res = await app.request('/artifacts/some-id');
      expect(res.status).toBe(401);
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
      const partialContext: Partial<AppContext> = {
        artifactRepository,
        userRepository,
        userMode: mockUserMode(OWNER),
      };
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
      const created = await artifactRepository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildAppWithOrder('shell-first');
      const res = await app.request(`/artifacts/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_SHELL_CSP);
      const body = await res.text();
      expect(body).toContain('<iframe sandbox="allow-scripts"');
    });

    it('SPA catch-all wins when registered BEFORE the shell (proves this test has real polarity, i.e. it would fail on an accidental reorder)', async () => {
      const created = await artifactRepository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildAppWithOrder('catch-all-first');
      const res = await app.request(`/artifacts/${created.id}`);
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
