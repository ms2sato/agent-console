/**
 * Client-Server Boundary Test: GET /api/artifacts (HTML Artifacts phase 2,
 * Issue #1313).
 *
 * Exercises the real chain the history page (`routes/artifacts/index.tsx`)
 * depends on: `fetchArtifacts()` (the real client function) -> real Hono
 * `GET /api/artifacts` handler -> real `SqliteArtifactRepository` -> JSON
 * response -> `ArtifactsListResponseSchema` parse (the same parser
 * `fetchArtifacts()` uses in production, per
 * `.claude/rules/pre-pr-completeness.md` Q10 -- neither the server's route
 * test (which asserts the raw JSON body shape) nor the client's component
 * test (which mocks `fetchArtifacts()` itself, bypassing the schema parse)
 * exercises this specific parse-at-the-real-wire path end-to-end).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
  TEST_AUTH_USER,
} from '@agent-console/server/src/__tests__/test-utils';
import type { AppBindings } from '@agent-console/server/src/app-context';
import { getDatabase } from '@agent-console/server/src/database/connection';
import { SqliteArtifactRepository } from '@agent-console/server/src/repositories/sqlite-artifact-repository';

import { fetchArtifacts } from '@agent-console/client/src/lib/api';

import { createFetchBridge, findRequest } from './test-utils';

describe('Client-Server Boundary: GET /api/artifacts', () => {
  let app: Hono<AppBindings>;
  let bridge: ReturnType<typeof createFetchBridge>;
  let repository: SqliteArtifactRepository;
  const originalHome = process.env.AGENT_CONSOLE_HOME;

  beforeEach(async () => {
    await setupTestEnvironment();

    // `SqliteArtifactRepository.create` writes the HTML file via
    // `lib/artifact-storage.ts`'s Bun-native `Bun.write` (deliberately not
    // `node:fs`, so it bypasses `setupTestEnvironment`'s memfs mock -- see
    // that file's own header comment). Point AGENT_CONSOLE_HOME at a real,
    // writable tmpdir for this test, same convention as
    // `routes/__tests__/artifacts.test.ts`.
    process.env.AGENT_CONSOLE_HOME = path.join(os.tmpdir(), `agent-console-artifact-list-boundary-${randomUUID()}`);

    repository = new SqliteArtifactRepository(getDatabase());
    app = await createTestApp({ artifactRepository: repository });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    await cleanupTestEnvironment();
    if (originalHome !== undefined) {
      process.env.AGENT_CONSOLE_HOME = originalHome;
    } else {
      delete process.env.AGENT_CONSOLE_HOME;
    }
  });

  it('survives the server -> JSON wire -> ArtifactsListResponseSchema parse round-trip, scoped to the caller', async () => {
    // Owned by the test's authenticated caller (TEST_AUTH_USER, per
    // `createTestApp`'s default SingleUserMode).
    await repository.create({
      id: randomUUID(),
      userId: TEST_AUTH_USER.id,
      title: 'My dashboard',
      content: '<p>dashboard</p>',
      sourceSessionId: null,
    });
    // Owned by someone else -- must NOT appear in the caller's list
    // (requirement 3 / §7's no-global-browse scoping, re-verified here at
    // the real wire boundary rather than assumed from the route unit test).
    // `artifacts.user_id` carries a real FK to `users.id`, so the other
    // owner needs a real row too.
    const now = new Date().toISOString();
    await getDatabase()
      .insertInto('users')
      .values({ id: 'someone-else', os_uid: null, username: 'someone-else', home_dir: '/home/someone-else', created_at: now, updated_at: now })
      .execute();
    await repository.create({
      id: randomUUID(),
      userId: 'someone-else',
      title: "Not the caller's",
      content: '<p>other</p>',
      sourceSessionId: null,
    });

    const result = await fetchArtifacts();

    const request = findRequest(bridge.capturedRequests, 'GET', '/api/artifacts');
    expect(request).toBeDefined();

    // The crucial assertion: if `ArtifactsListResponseSchema` (or
    // `ArtifactSchema`) silently drops/renames a field, `v.parse` inside
    // `fetchArtifacts()` throws and this whole test fails, rather than the
    // client silently receiving `undefined` fields in production.
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('My dashboard');
    expect(typeof result[0].id).toBe('string');
    expect(typeof result[0].createdAt).toBe('string');
    expect(typeof result[0].sizeBytes).toBe('number');
  });

  it('returns an empty array (boundary value) when the caller has no artifacts', async () => {
    const result = await fetchArtifacts();
    expect(result).toEqual([]);
  });
});
