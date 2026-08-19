/**
 * Sibling test for the HTML artifact routes (Issue #1312, HTML Artifacts
 * phase 1, S3/S4 -- serving, list, delete).
 *
 * Deliberately built on top of the REAL `SqliteArtifactRepository` (real
 * in-memory sqlite db + real filesystem under `os.tmpdir()`), not memfs +
 * mocks: `GET /:id` calls `lib/artifact-storage.ts`'s `readArtifactFile`
 * directly, which is Bun-native (`Bun.file`) and bypasses the process-global
 * `mock.module('fs/promises')` interception `test-utils.ts` installs (see
 * the parallel note in `repositories/__tests__/sqlite-artifact-repository.test.ts`).
 * A real repository also gives the delete-ownership tests genuine row+file
 * verification instead of asserting mock-call-shape only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Kysely } from 'kysely';
import * as v from 'valibot';
import type { AuthUser } from '@agent-console/shared';
import { ArtifactSchema } from '@agent-console/shared';
import type { Database } from '../../database/schema.js';
import { createDatabaseForTest } from '../../database/connection.js';
import { SqliteArtifactRepository } from '../../repositories/sqlite-artifact-repository.js';
import { readArtifactFile } from '../../lib/artifact-storage.js';
import {
  mintArtifactViewerToken,
  consumeArtifactViewerToken,
  ARTIFACT_VIEWER_TOKEN_TTL_MS,
} from '../../lib/artifact-viewer-tokens.js';
import { artifacts, ARTIFACT_SERVING_CSP } from '../artifacts.js';
import { authMiddleware } from '../../middleware/auth.js';
import { onApiError } from '../../lib/error-handler.js';
import type { AppBindings, AppContext } from '../../app-context.js';
import type { UserMode, PtySpawnRequest } from '../../services/user-mode.js';
import type { PtyInstance } from '../../lib/pty-provider.js';

// ---------------------------------------------------------------------------
// Test users
// ---------------------------------------------------------------------------

const OWNER: AuthUser = { id: 'owner-1', username: 'owner', homeDir: '/home/owner' };
const OTHER: AuthUser = { id: 'other-1', username: 'other', homeDir: '/home/other' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Builds a Hono app that mirrors production layering for `/api/artifacts`:
 * appContext -> authMiddleware -> route. `authenticateResult` controls
 * whether the simulated request is authenticated (P4).
 */
function buildApp(
  artifactRepository: SqliteArtifactRepository,
  authenticateResult: AuthUser | null,
): Hono<AppBindings> {
  const partialContext: Partial<AppContext> = {
    artifactRepository,
    userMode: mockUserMode(authenticateResult),
  };
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('appContext', partialContext as AppContext);
    await next();
  });
  app.use('*', authMiddleware);
  app.onError(onApiError);
  app.route('/api/artifacts', artifacts);
  return app;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Artifact routes', () => {
  const originalHome = process.env.AGENT_CONSOLE_HOME;
  let db: Kysely<Database>;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    process.env.AGENT_CONSOLE_HOME = path.join(os.tmpdir(), `agent-console-artifact-routes-test-${randomUUID()}`);
    db = await createDatabaseForTest();
    repository = new SqliteArtifactRepository(db);

    // `artifacts.user_id` carries a real FK to `users.id` -- seed the two
    // test users this file's tests attribute artifacts to.
    const now = new Date().toISOString();
    for (const user of [OWNER, OTHER]) {
      await db
        .insertInto('users')
        .values({ id: user.id, os_uid: null, username: user.username, home_dir: user.homeDir, created_at: now, updated_at: now })
        .execute();
    }
  });

  afterEach(async () => {
    await db.destroy();
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  // =========================================================================
  // ARTIFACT_SERVING_CSP constant
  // =========================================================================

  describe('ARTIFACT_SERVING_CSP', () => {
    it('is the exact fixed string from docs/design/html-artifacts.md §3', () => {
      expect(ARTIFACT_SERVING_CSP).toBe(
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'",
      );
    });

    it('never contains allow-same-origin', () => {
      expect(ARTIFACT_SERVING_CSP).not.toContain('allow-same-origin');
    });
  });

  // =========================================================================
  // GET /api/artifacts/:id
  // =========================================================================

  describe('GET /api/artifacts/:id', () => {
    it('serves stored HTML byte-verbatim with the exact CSP/headers, including a payload a sanitizer would alter', async () => {
      const payload =
        '<html><body><img src=x onerror="alert(1)"><script>window.parent.postMessage("hi","*")</script></body></html>';
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'Probe',
        content: payload,
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      // Sec-Fetch-Dest: iframe simulates a legitimate iframe-embedded fetch
      // (what the production viewer shell's <iframe src="..."> load sends
      // per spec) -- this test asserts the byte-serving path specifically,
      // gated by the P6 check added alongside the navigation-jail shell.
      // See the "Sec-Fetch-Dest gating (P6)" describe block below for the
      // gate's own coverage.
      const res = await app.request(`/api/artifacts/${created.id}`, {
        headers: { 'Sec-Fetch-Dest': 'iframe' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toBe(ARTIFACT_SERVING_CSP);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');

      const body = await res.text();
      // Byte-verbatim: a sanitizer would have stripped `onerror`/`<script>`.
      expect(body).toBe(payload);
    });

    it('returns 404 for a nonexistent artifact id', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/artifacts/does-not-exist', {
        headers: { 'Sec-Fetch-Dest': 'iframe' },
      });
      expect(res.status).toBe(404);
    });

    it('rejects an unauthenticated request with 401 (P4)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, null);
      const res = await app.request(`/api/artifacts/${created.id}`);
      expect(res.status).toBe(401);
    });

    it('allows any authenticated user to view an artifact they do not own (requirement 3)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'Owned by owner',
        content: '<p>owned by owner</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OTHER);
      const res = await app.request(`/api/artifacts/${created.id}`, {
        headers: { 'Sec-Fetch-Dest': 'iframe' },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<p>owned by owner</p>');
    });
  });

  // =========================================================================
  // GET /api/artifacts/:id -- Sec-Fetch-Dest + viewer-token two-tier gate
  // (P6', reworked for Issue #1366 -- header-blind origins). Matrix per the
  // Architect-approved AC:
  //
  //   | Sec-Fetch-Dest    | token                          | expected |
  //   |-------------------|--------------------------------|----------|
  //   | iframe            | any / none                     | serve (token NOT consumed) |
  //   | document / other  | valid                           | redirect (header wins) |
  //   | absent            | valid + unspent, id matches     | serve + token consumed  |
  //   | absent            | spent / expired / absent / wrong-id | redirect |
  // =========================================================================

  describe("GET /api/artifacts/:id -- Sec-Fetch-Dest + viewer-token two-tier gate (P6')", () => {
    it('serves raw bytes when Sec-Fetch-Dest is exactly "iframe" (header wins, no token needed)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}`, {
        headers: { 'Sec-Fetch-Dest': 'iframe' },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<p>x</p>');
    });

    it('serves raw bytes when Sec-Fetch-Dest is "iframe" even with an invalid token present, and does NOT consume a valid token supplied alongside it (header wins outright, token ignored)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });
      const token = mintArtifactViewerToken(created.id);

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=${token}`, {
        headers: { 'Sec-Fetch-Dest': 'iframe' },
      });
      expect(res.status).toBe(200);

      // The token must still be unspent -- the iframe branch never touches
      // it. Consuming it now (via the header-absent path) proves this.
      expect(consumeArtifactViewerToken(token, created.id)).toBe(true);
    });

    it('redirects (302) to the viewer shell when Sec-Fetch-Dest is "document" (a top-level browser navigation), EVEN with a valid token (header wins)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });
      const token = mintArtifactViewerToken(created.id);

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=${token}`, {
        headers: { 'Sec-Fetch-Dest': 'document' },
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/artifacts/${created.id}`);

      // The header branch ignores the token entirely -- it must still be
      // unspent afterward.
      expect(consumeArtifactViewerToken(token, created.id)).toBe(true);
    });

    it('redirects (302) to the viewer shell when Sec-Fetch-Dest is ABSENT and no token is supplied -- the fail-closed default for old browsers / non-browser clients (curl, plain fetch), now also the "absent + no token" row', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      // No Sec-Fetch-Dest header at all, no ?vt= query param either.
      const res = await app.request(`/api/artifacts/${created.id}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/artifacts/${created.id}`);
    });

    it('serves raw bytes when Sec-Fetch-Dest is ABSENT but a valid, unspent, id-matching token is supplied (header-blind origin fallback, Issue #1366), and consumes the token', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });
      const token = mintArtifactViewerToken(created.id);

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=${token}`, { redirect: 'manual' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<p>x</p>');

      // Single-use polarity: an immediate second identical request must
      // now redirect, since the token was consumed by the first.
      const secondRes = await app.request(`/api/artifacts/${created.id}?vt=${token}`, { redirect: 'manual' });
      expect(secondRes.status).toBe(302);
      expect(secondRes.headers.get('Location')).toBe(`/artifacts/${created.id}`);
    });

    it('redirects (302) when the token is already spent (single-use)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });
      const token = mintArtifactViewerToken(created.id);
      // Spend it directly via the store, mirroring what the route itself
      // does on a first successful serve.
      expect(consumeArtifactViewerToken(token, created.id)).toBe(true);

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=${token}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/artifacts/${created.id}`);
    });

    it('redirects (302) when the token is expired (TTL honored, fake clock -- no sleeping)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });
      // Mint with a clock already ARTIFACT_VIEWER_TOKEN_TTL_MS + 1ms in the
      // past, so the token is expired by the time the route (using the
      // real Date.now internally) checks it -- no sleeping required.
      const expiredToken = mintArtifactViewerToken(created.id, () => Date.now() - ARTIFACT_VIEWER_TOKEN_TTL_MS - 1);

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=${expiredToken}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/artifacts/${created.id}`);
    });

    it('redirects (302) when the token is bound to a DIFFERENT artifact id (id-bound)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });
      const otherArtifact = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'Other',
        content: '<p>other</p>',
        sourceSessionId: null,
      });
      const tokenForOther = mintArtifactViewerToken(otherArtifact.id);

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=${tokenForOther}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/artifacts/${created.id}`);
    });

    it('redirects (302) when the ?vt= query param is present but empty', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}?vt=`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/artifacts/${created.id}`);
    });

    it('the raw 200 response carries Cache-Control: no-store (closes the browser-cache single-use bypass)', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}`, {
        headers: { 'Sec-Fetch-Dest': 'iframe' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  // =========================================================================
  // GET /api/artifacts
  // =========================================================================

  describe('GET /api/artifacts', () => {
    it("returns only the caller's own artifacts, newest first, matching the ArtifactSchema wire shape", async () => {
      await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'Old',
        content: '<p>old</p>',
        sourceSessionId: null,
      });
      await new Promise((r) => setTimeout(r, 2));
      await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'New',
        content: '<p>new</p>',
        sourceSessionId: null,
      });
      await repository.create({
        id: randomUUID(),
        userId: OTHER.id,
        title: "Other user's artifact",
        content: '<p>other</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/artifacts');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { artifacts: unknown[] };
      expect(body.artifacts).toHaveLength(2);
      expect((body.artifacts as { title: string }[]).map((a) => a.title)).toEqual(['New', 'Old']);

      // Parse each entry through the real wire schema (closes the Q10 gap:
      // a server-side field addition/removal that valibot would silently
      // strip must fail this parse, not just a hand-checked object shape).
      for (const entry of body.artifacts) {
        const parsed = v.parse(ArtifactSchema, entry);
        expect(parsed.title).toBeDefined();
      }
    });

    it('returns an empty array when the caller has no artifacts (boundary value)', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/artifacts');
      expect(res.status).toBe(200);

      const body = (await res.json()) as { artifacts: unknown[] };
      expect(body.artifacts).toEqual([]);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const app = buildApp(repository, null);
      const res = await app.request('/api/artifacts');
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // DELETE /api/artifacts/:id
  // =========================================================================

  describe('DELETE /api/artifacts/:id', () => {
    it('lets the owner delete their own artifact, removing row and file together', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'To delete',
        content: '<p>bye</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OWNER);
      const res = await app.request(`/api/artifacts/${created.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      expect(await repository.findById(created.id)).toBeNull();
      expect(await readArtifactFile(OWNER.id, created.id)).toBeNull();
    });

    it('rejects a non-owner delete with 403, leaving row and file untouched', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'Not yours',
        content: '<p>mine</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, OTHER);
      const res = await app.request(`/api/artifacts/${created.id}`, { method: 'DELETE' });

      expect(res.status).toBe(403);

      const stillThere = await repository.findById(created.id);
      expect(stillThere).not.toBeNull();
      expect(stillThere?.userId).toBe(OWNER.id);
      expect(await readArtifactFile(OWNER.id, created.id)).toBe('<p>mine</p>');
    });

    it('returns 404 for a nonexistent artifact id', async () => {
      const app = buildApp(repository, OWNER);
      const res = await app.request('/api/artifacts/does-not-exist', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const created = await repository.create({
        id: randomUUID(),
        userId: OWNER.id,
        title: 'T',
        content: '<p>x</p>',
        sourceSessionId: null,
      });

      const app = buildApp(repository, null);
      const res = await app.request(`/api/artifacts/${created.id}`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    });
  });
});
