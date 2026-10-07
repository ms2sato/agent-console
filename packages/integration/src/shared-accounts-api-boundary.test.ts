/**
 * Client-Server Boundary Test: Shared Accounts REST API
 * (shared-accounts design, epic #1841, Release 1).
 *
 * `packages/integration/src/shared-account-username-boundary.test.ts`
 * already locks `Repository.sharedAccountUsername`'s survival through the
 * REST plain-object shape and the WS `repository-updated` schema, but it
 * drives `RepositoryManager.updateRepository` directly -- it never goes
 * through the real HTTP routes, and it never calls the real client
 * functions in `packages/client/src/lib/api.ts`. This file closes that gap:
 * it exercises the real client functions (`fetchSharedAccounts`,
 * `registerSharedAccount`, `unregisterSharedAccount`, `registerRepository`,
 * `fetchRepository`, `updateRepository`) against the real
 * `/api/shared-accounts` and `/api/repositories` Hono routes, via the Server
 * Bridge Pattern (`createFetchBridge`).
 *
 * This matters most for `fetchSharedAccounts()`, which parses the server's
 * JSON body through `ListSharedAccountsResponseSchema` --
 * `v.strictObject`, so an unrecognized field on the server's response
 * object causes the WHOLE parse to fail, not just that field to be
 * dropped (see Q10's `v.strictObject` note in
 * `.claude/rules/pre-pr-completeness.md`). Neither the server unit tests
 * (which never cross the schema boundary) nor the client unit tests (which
 * inject pre-built mock objects that bypass `v.parse` entirely) can catch
 * this class of drift; see
 * `.claude/rules/pre-pr-completeness.md` Q10's PR #926 lesson for the
 * concrete precedent this guards against.
 *
 * PROXY (pre-pr-completeness.md Q13 "recorded-proxy discipline"):
 * `packages/server/src/routes/shared-accounts.ts` calls the real
 * `lookupOsUser(username)` directly -- there is no dependency-injection
 * seam on the route itself (unlike `SharedAccountRegistry.createFromDb`,
 * which DOES accept an injectable `lookupOsUser` for its own startup
 * resolution). Any username registered through the real
 * `POST /api/shared-accounts` route in this file must therefore be a
 * username that genuinely resolves via the real OS on whatever machine runs
 * this test. This file uses `os.userInfo().username` (`REAL_OS_USERNAME`)
 * for that purpose, the same approach
 * `packages/server/src/routes/__tests__/shared-accounts.test.ts` already
 * uses. Using the real current-process OS account in place of an arbitrary
 * shared-account name is upstream of, and outside, the chain under test --
 * it changes WHICH username resolves, never what the route does with a
 * resolved username.
 *
 * Scenario (d) (`importEnvSharedAccount` round-trip against
 * `POST /api/shared-accounts/import-env`) was removed in Release 2
 * (docs/design/shared-orchestrator-session.md): the env var is no longer a
 * session-creation or registration source and the route no longer exists.
 * Scenario (a)'s `registerSharedAccount` + `fetchSharedAccounts` round-trip
 * already covers the same strict-wire-schema reach that (d) used to cover.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'os';
import type { Hono } from 'hono';

import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
  getTestConfigDir,
  TEST_AUTH_USER,
} from '@agent-console/server/src/__tests__/test-utils';
import { setupMemfs } from '@agent-console/server/src/__tests__/utils/mock-fs-helper';
import { getDatabase } from '@agent-console/server/src/database/connection';
import { SqliteSharedAccountRepository } from '@agent-console/server/src/repositories/sqlite-shared-account-repository';
import { SqliteUserRepository } from '@agent-console/server/src/repositories/sqlite-user-repository';
import { SqliteRepositoryRepository } from '@agent-console/server/src/repositories/sqlite-repository-repository';
import { RepositoryManager } from '@agent-console/server/src/services/repository-manager';
import { serverConfig } from '@agent-console/server/src/lib/server-config';
import type { AppBindings } from '@agent-console/server/src/app-context';

import {
  fetchSharedAccounts,
  registerSharedAccount,
  unregisterSharedAccount,
  registerRepository,
  fetchRepository,
  updateRepository,
  ApiError,
} from '@agent-console/client/src/lib/api';

import { createFetchBridge, findRequest } from './test-utils';

const TEST_REPO_PATH = '/test/repo-shared-accounts-api';

// See this file's header "PROXY" note.
const REAL_OS_USERNAME = os.userInfo().username;

describe('Client-Server Boundary: Shared Accounts REST API', () => {
  let app: Hono<AppBindings>;
  let bridge: ReturnType<typeof createFetchBridge>;
  let sharedAccountRepository: SqliteSharedAccountRepository;
  let userRepository: SqliteUserRepository;
  let repositoryManager: RepositoryManager;
  let originalAuthMode: string;

  beforeEach(async () => {
    // Defensive per-run guard (see this file's header "PROXY" note): if a
    // future CI image ever runs this suite as an OS user literally named
    // `testuser`, the personal-session/self-registration guards in
    // `routes/shared-accounts.ts` would trip unexpectedly for reasons that
    // have nothing to do with the behavior under test. Fail loudly instead
    // of silently exercising the wrong guard path.
    expect(REAL_OS_USERNAME).not.toBe(TEST_AUTH_USER.username);

    await setupTestEnvironment();

    originalAuthMode = serverConfig.AUTH_MODE;
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = 'multi-user';

    setupMemfs({
      [`${getTestConfigDir()}/.keep`]: '',
      [`${TEST_REPO_PATH}/.git/HEAD`]: 'ref: refs/heads/main',
    });

    const db = getDatabase();
    sharedAccountRepository = new SqliteSharedAccountRepository(db);
    userRepository = new SqliteUserRepository(db);
    repositoryManager = await RepositoryManager.create({
      repository: new SqliteRepositoryRepository(db),
    });

    // `POST /` also reads `db` directly off the AppContext (the
    // personal-session guard's own query), so it must be wired here too,
    // not just the repositories built on top of it.
    app = await createTestApp({ db, sharedAccountRepository, userRepository, repositoryManager });
    bridge = createFetchBridge(app);
  });

  afterEach(async () => {
    bridge.restore();
    (serverConfig as { AUTH_MODE: string }).AUTH_MODE = originalAuthMode;
    await cleanupTestEnvironment();
  });

  it('(a) registerSharedAccount then fetchSharedAccounts round-trips through the strict wire schema', async () => {
    const registerResult = await registerSharedAccount(REAL_OS_USERNAME);

    const registerRequest = findRequest(bridge.capturedRequests, 'POST', '/api/shared-accounts');
    expect(registerRequest).toBeDefined();
    expect(registerRequest!.body).toEqual({ username: REAL_OS_USERNAME });
    expect(registerResult.username).toBe(REAL_OS_USERNAME);

    const list = await fetchSharedAccounts();

    const listRequest = findRequest(bridge.capturedRequests, 'GET', '/api/shared-accounts');
    expect(listRequest).toBeDefined();

    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({
      username: REAL_OS_USERNAME,
      boundRepositoryCount: 0,
      sessionCount: 0,
    });

    // POLARITY MEASURED (pre-pr-completeness.md Q10 / this file's header):
    // with an extra `bogusExtraField: 'x'` added to the per-account object
    // literal `GET /` builds in
    // `packages/server/src/routes/shared-accounts.ts`, this test failed --
    // `fetchSharedAccounts()`'s `v.parse(ListSharedAccountsResponseSchema, ...)`
    // synchronously threw a `ValiError: Invalid key: Expected never but
    // received "bogusExtraField"` (`v.strictObject` rejects the WHOLE
    // response on an unrecognized field), caught by bun:test as a failing
    // `it` block, rather than merely producing a list entry missing the
    // extra field. Reverted immediately after; `git diff --stat
    // packages/server/src/routes/shared-accounts.ts` showed no diff
    // against the prior commit.
  });

  it('(b) updateRepository binds sharedAccountUsername; fetchRepository re-reads it; null unbinds', async () => {
    await registerSharedAccount(REAL_OS_USERNAME);

    const { repository } = await registerRepository({ path: TEST_REPO_PATH });
    const repoId = repository.id;
    expect(repository.sharedAccountUsername ?? null).toBeNull();

    const bound = await updateRepository(repoId, { sharedAccountUsername: REAL_OS_USERNAME });
    const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', `/api/repositories/${repoId}`);
    expect(patchRequest).toBeDefined();
    expect(patchRequest!.body).toEqual({ sharedAccountUsername: REAL_OS_USERNAME });
    expect(bound.repository.sharedAccountUsername).toBe(REAL_OS_USERNAME);

    // A SEPARATE re-read must show the bound value too, not merely echo the
    // PATCH response.
    const rereadAfterBind = await fetchRepository(repoId);
    expect(rereadAfterBind.repository.sharedAccountUsername).toBe(REAL_OS_USERNAME);

    const unbound = await updateRepository(repoId, { sharedAccountUsername: null });
    expect(unbound.repository.sharedAccountUsername ?? null).toBeNull();

    const rereadAfterUnbind = await fetchRepository(repoId);
    expect(rereadAfterUnbind.repository.sharedAccountUsername ?? null).toBeNull();
  });

  it('(c) unregisterSharedAccount rejects with a 409 ApiError while bound; succeeds once unbound', async () => {
    await registerSharedAccount(REAL_OS_USERNAME);
    const { repository } = await registerRepository({ path: TEST_REPO_PATH });
    await updateRepository(repository.id, { sharedAccountUsername: REAL_OS_USERNAME });

    let caught: unknown;
    try {
      await unregisterSharedAccount(REAL_OS_USERNAME);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);

    // Still registered -- the rejected call must not have had a side effect.
    const listAfterRejection = await fetchSharedAccounts();
    expect(listAfterRejection.accounts).toHaveLength(1);

    // Unbind, then the same unregister call must succeed.
    await updateRepository(repository.id, { sharedAccountUsername: null });
    await expect(unregisterSharedAccount(REAL_OS_USERNAME)).resolves.toBeUndefined();

    const listAfterUnregister = await fetchSharedAccounts();
    expect(listAfterUnregister.accounts).toHaveLength(0);
  });

  it('(e) updateRepository with NO sharedAccountUsername key leaves an existing binding untouched while other fields change', async () => {
    // Pins the safety claim behind the EditRepositoryForm load-failure state:
    // when shared accounts cannot be loaded, the client omits the
    // `sharedAccountUsername` key entirely, and the route's `!== undefined`
    // gate must then preserve the existing binding (omitted != null).
    await registerSharedAccount(REAL_OS_USERNAME);
    const { repository } = await registerRepository({ path: TEST_REPO_PATH });
    const repoId = repository.id;
    await updateRepository(repoId, { sharedAccountUsername: REAL_OS_USERNAME });

    await updateRepository(repoId, { description: 'changed by (e)' });

    // An earlier PATCH (the bind) exists, so take the LAST matching one.
    const patchRequests = bridge.capturedRequests.filter(
      (r) => r.method === 'PATCH' && r.url.includes(`/api/repositories/${repoId}`)
    );
    const lastPatch = patchRequests[patchRequests.length - 1];
    expect(lastPatch).toBeDefined();
    expect(lastPatch.body).not.toHaveProperty('sharedAccountUsername');
    expect(lastPatch.body).toHaveProperty('description', 'changed by (e)');

    const reread = await fetchRepository(repoId);
    expect(reread.repository.sharedAccountUsername).toBe(REAL_OS_USERNAME);
    expect(reread.repository.description).toBe('changed by (e)');
  });
});
