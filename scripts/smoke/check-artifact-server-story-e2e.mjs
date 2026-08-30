#!/usr/bin/env bun
/**
 * Real-server-story E2E for the HTML Artifacts server routes/tool (Issue
 * #1312, docs/design/html-artifacts.md §6/§8, AC "V2" terminal half + "V3").
 *
 * Boots a disposable, real server instance and drives it exclusively over
 * real HTTP (real login, real cookie, real `/mcp` JSON-RPC, real
 * `fetch()` against `/api/artifacts/*`), then performs a real, direct
 * on-disk SQLite read to verify a field ( `user_id`) the routes' own JSON
 * responses never expose (see `packages/shared/src/types/artifact.ts`'s
 * wire-shape JSDoc -- `userId` is deliberately excluded from every wire
 * response).
 *
 * ============================================================================
 * WHAT THIS SCRIPT VERIFIES
 * ============================================================================
 *
 * V2 (terminal half only -- the embedded half is explicitly out of scope
 * here, a separate round): a real MCP call over `/mcp` from a real session
 * (the same tokenless-call shape a real terminal agent's MCP client makes
 * today, per `mcp-server.ts`'s default `AGENT_CONSOLE_MCP_AUTH=warn`) ->
 * artifact created, the artifact's stored `user_id` equals that session's
 * `createdBy`, and the URL serves 200.
 *
 * V3: create (reuses the same artifact V2 already created -- creating a
 * second one would not exercise anything new) -> serve (200 with the
 * EXACT `Content-Security-Policy` header string) -> list (present) ->
 * delete -> serve (404). This is the real-HTTP round trip the design
 * doc's decomposition ruling requires as Phase 1's caller for the routes.
 *
 * ============================================================================
 * SHARED INFRASTRUCTURE WITH V1 (`check-artifact-sandbox-boundary.mjs`)
 * ============================================================================
 *
 * This script duplicates (rather than imports) V1's disposable-instance
 * boot / credential-issuance / MCP JSON-RPC helpers, INCLUDING
 * `mintRealSessionToken` (real OS user lookup, real DB upsert, real
 * on-disk-secret JWT signing -- see V1's "CREDENTIAL-ISSUANCE
 * SUBSTITUTION" header comment for the full rationale, including why an
 * earlier `validateOsCredentials` monkey-patch was withdrawn as a security
 * defect and replaced with this direct-mint approach). Deliberate:
 * extracting a shared module at this second consumer would touch (and
 * risk destabilizing) V1's file, which multiple rounds of this PR were
 * told not to touch beyond what each round's fix required. This repo's
 * convention is "duplicate once, extract at the second real consumer" --
 * the bias here is toward NOT touching V1's file for reasons unrelated to
 * its own fixes, which the extraction path cannot guarantee. See V1's
 * script for the full rationale on each piece (in-process import for
 * module-cache identity, etc.) -- not re-derived here, only the parts
 * relevant to V2/V3 are repeated. This script never drives a real browser
 * (no Playwright), so its credential is delivered as a plain `Cookie:`
 * header on `fetch()` calls -- no cookie-jar `domain`/`secure`/`sameSite`
 * attributes to construct, unlike V1's script.
 *
 * Usage:
 *   bun scripts/smoke/check-artifact-server-story-e2e.mjs
 *
 * Exit codes:
 *   0  all assertions passed
 *   1  one or more assertions failed (a real regression)
 *   2  bad usage / environment problem (server failed to boot, etc.)
 */

import { Database as BunDatabase } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

/**
 * `jose` is a dependency of `packages/server`, not of this script's own
 * directory -- a bare `import('jose')` from here fails to resolve (Bun's
 * bare-specifier resolution is rooted at the importing file's own
 * directory, walking up its ancestors only). `createRequire`, rooted at a
 * path inside `packages/server/src/`, resolves it exactly the way that
 * package's own code would; duplicated from V1's script (same rationale).
 */
async function importJoseFromServerPackage() {
  const requireFromServer = createRequire(path.join(REPO_ROOT, 'packages/server/src/services/user-mode.ts'));
  const joseEntryPath = requireFromServer.resolve('jose');
  return import(joseEntryPath);
}

// ---------------------------------------------------------------------------
// Mini assertion harness -- same shape as V1's script.
// ---------------------------------------------------------------------------
const failures = [];
let passes = 0;

let disposableHomeForCleanup;

function expect(cond, label, detail) {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

/** Find a free TCP port by letting the OS assign one, then releasing it. */
function getFreePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Poll GET /health until the disposable server accepts connections. */
async function waitForServerReady(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(150);
  }
  throw new Error(`Disposable server did not become ready within ${timeoutMs}ms: ${lastErr}`);
}

/**
 * Mint a REAL session credential directly, replicating every step of
 * `MultiUserMode.login()` (`services/user-mode.ts`) that runs AFTER
 * password validation. Duplicated from V1's script
 * (`check-artifact-sandbox-boundary.mjs`'s `mintRealSessionToken`) per
 * this file's own stated "duplicate once, extract at the second real
 * consumer" convention -- see V1's "CREDENTIAL-ISSUANCE SUBSTITUTION"
 * header comment for the full Q13 justification and the security
 * rationale for why this replaces an interactive-login-style approach.
 * MUST be called AFTER the disposable server is ready: both the JWT
 * secret file and the database singleton this function reaches into are
 * created during the server's own boot sequence.
 */
async function mintRealSessionToken(disposableHome, osUsername) {
  const { lookupOsUser } = await import('../../packages/server/src/services/os-user-lookup.ts');
  const { initializeDatabase } = await import('../../packages/server/src/database/connection.ts');
  const { SqliteUserRepository } = await import('../../packages/server/src/repositories/sqlite-user-repository.ts');
  const { SignJWT } = await importJoseFromServerPackage();

  const userInfo = await lookupOsUser(osUsername);
  if (!userInfo) {
    throw new Error(`mintRealSessionToken: lookupOsUser('${osUsername}') returned null -- cannot mint a session for this OS user`);
  }

  // Fast path: initializeDatabase() called with NO dbPath argument returns
  // the SAME cached Kysely instance the running server itself uses -- not
  // a second/divergent connection (same module-cache-identity rationale
  // used elsewhere in this file, e.g. the direct SQLite read below).
  const db = await initializeDatabase();
  const userRepository = new SqliteUserRepository(db);
  const authUser = await userRepository.upsertByOsUid(userInfo.uid, osUsername, userInfo.homeDir);

  // Real per-instance secret, written to disk by the server's own
  // `MultiUserMode.create()` at boot (`services/user-mode.ts`'s
  // `JWT_SECRET_FILE` constant is the literal string 'jwt-secret').
  const jwtSecret = new Uint8Array(await Bun.file(path.join(disposableHome, 'jwt-secret')).arrayBuffer());

  // EXACT payload shape / algorithm / expiry `MultiUserMode.login()` signs.
  const token = await new SignJWT({ username: authUser.username, home: authUser.homeDir })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(authUser.id)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(jwtSecret);

  return { token, authUser };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers -- real HTTP against the disposable server's own
// /mcp endpoint (dev-environment-quirks skill's "driving MCP against a
// throwaway instance you started yourself" pattern: no pre-registered MCP
// client, raw JSON-RPC over fetch -- the same transport a real terminal
// agent's MCP client uses).
// ---------------------------------------------------------------------------
async function initializeMcp(baseUrl) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'artifact-server-story-e2e', version: '1.0.0' } },
      id: 1,
    }),
  });
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callMcpTool(baseUrl, mcpSessionId, name, args) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': mcpSessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 2 }),
  });
  const json = await res.json();
  const text = json.result?.content?.[0]?.text;
  if (json.result?.isError) {
    throw new Error(`MCP tool ${name} returned an error result: ${text}`);
  }
  if (!text) {
    throw new Error(`MCP tool ${name} returned no text content: ${JSON.stringify(json)}`);
  }
  return JSON.parse(text);
}

const PROBE_ARTIFACT_HTML =
  '<!doctype html><html><head><title>Server Story E2E Probe</title></head>' +
  '<body><h1>hello from #1312 V2/V3 E2E</h1></body></html>';

async function main() {
  process.chdir(REPO_ROOT);

  // -------------------------------------------------------------------
  // Server bring-up: disposable AGENT_CONSOLE_HOME, multi-user auth mode
  // (needed for a real cookie-based session; AUTH_MODE=none has no
  // per-user attribution to check against).
  // -------------------------------------------------------------------
  const disposableHome = path.join(os.tmpdir(), `agent-console-1312-v2v3-verify-${process.pid}-${Date.now()}`);
  disposableHomeForCleanup = disposableHome;
  mkdirSync(disposableHome, { recursive: true });
  console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);

  const port = getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`==> disposable server target: ${baseUrl}`);

  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'multi-user';
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  // getDbPath() is imported live (not hardcoded) so this script cannot
  // silently drift from lib/config.ts's actual DB path resolution.
  const configModule = await import('../../packages/server/src/lib/config.ts');

  console.log('==> booting disposable server in-process...');
  await import('../../packages/server/src/index.ts');
  await waitForServerReady(baseUrl);
  console.log('==> disposable server is ready');

  let sqliteHandle;
  try {
    // -----------------------------------------------------------------
    // Real session credential: minted directly (see mintRealSessionToken
    // above) rather than through the real /api/auth/login HTTP endpoint --
    // that endpoint is never called by this script.
    // -----------------------------------------------------------------
    const osUsername = os.userInfo().username;
    const { token: sessionToken, authUser: mintedAuthUser } = await mintRealSessionToken(disposableHome, osUsername);
    const { AUTH_COOKIE_NAME } = await import('../../packages/server/src/lib/auth-constants.ts');
    const cookieHeader = `${AUTH_COOKIE_NAME}=${sessionToken}`;
    console.log(`==> real session credential minted for OS user '${osUsername}' (userId=${mintedAuthUser.id})`);

    // -----------------------------------------------------------------
    // Real session (a real terminal-session shape, same as V1's script).
    // -----------------------------------------------------------------
    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ type: 'quick', locationPath: disposableHome }),
    });
    if (!sessionRes.ok) {
      throw new Error(`Session creation failed (status ${sessionRes.status}): ${await sessionRes.text()}`);
    }
    const { session } = await sessionRes.json();
    console.log(`==> real session created: ${session.id} (createdBy=${session.createdBy})`);
    expect(!!session.createdBy, 'created session has a resolvable createdBy', `createdBy=${session.createdBy}`);

    // ===================================================================
    // V2 (terminal half): real MCP call over /mcp.
    // ===================================================================
    console.log('\n==> V2 (terminal half): create_html_artifact via real /mcp JSON-RPC');
    const mcpSessionId = await initializeMcp(baseUrl);
    const toolResult = await callMcpTool(baseUrl, mcpSessionId, 'create_html_artifact', {
      content: PROBE_ARTIFACT_HTML,
      title: 'Server Story E2E Probe',
      sessionId: session.id,
    });
    console.log(`==> artifact created via real MCP call: ${JSON.stringify(toolResult)}`);
    expect(!!toolResult.artifactId, 'V2: tool result carries an artifactId', JSON.stringify(toolResult));
    expect(
      toolResult.path === `/artifacts/${toolResult.artifactId}`,
      'V2: tool result path matches the expected /artifacts/:id shape',
      JSON.stringify(toolResult),
    );
    const artifactId = toolResult.artifactId;
    const artifactUrl = `${baseUrl}/api${toolResult.path}`;

    // V2's DB-verification step: the JSON responses (tool result AND the
    // list endpoint, per packages/shared/src/types/artifact.ts's wire-shape
    // JSDoc) never expose userId, so the only way to check attribution is
    // a direct read of the disposable instance's own SQLite file.
    const dbPath = configModule.getDbPath();
    sqliteHandle = new BunDatabase(dbPath, { readonly: true });
    const row = sqliteHandle.query('SELECT user_id FROM artifacts WHERE id = ?').get(artifactId);
    console.log(`==> direct SQLite read of ${dbPath}: artifacts.user_id = ${row?.user_id}`);
    expect(
      !!row && row.user_id === session.createdBy,
      "V2: the artifact's stored user_id equals the session's createdBy",
      `row.user_id=${row?.user_id}, session.createdBy=${session.createdBy}`,
    );

    // Sec-Fetch-Dest: iframe simulates a legitimate iframe-embedded load
    // (what the production viewer shell's <iframe src="..."> actually
    // sends) -- required to reach the byte-serving path now that the
    // navigation-jail P6 gate redirects everything else to the shell.
    const v2ServeRes = await fetch(artifactUrl, { headers: { Cookie: cookieHeader, 'Sec-Fetch-Dest': 'iframe' } });
    expect(v2ServeRes.status === 200, 'V2: fetch() of the returned artifact URL is HTTP 200', `status=${v2ServeRes.status}`);
    // Drain the body so this response doesn't linger as an open connection.
    await v2ServeRes.text();

    // ===================================================================
    // V3: create (reuses the V2 artifact) -> serve -> list -> delete -> serve.
    // ===================================================================
    console.log('\n==> V3: real HTTP round trip (create already done above; serve -> list -> delete -> serve)');

    const routesModule = await import('../../packages/server/src/routes/artifacts.ts');
    const serveRes = await fetch(artifactUrl, { headers: { Cookie: cookieHeader, 'Sec-Fetch-Dest': 'iframe' } });
    expect(serveRes.status === 200, 'V3 serve: GET /api/artifacts/:id is HTTP 200', `status=${serveRes.status}`);
    expect(
      serveRes.headers.get('Content-Security-Policy') === routesModule.ARTIFACT_SERVING_CSP,
      'V3 serve: Content-Security-Policy header is the EXACT ARTIFACT_SERVING_CSP constant',
      `observed=${JSON.stringify(serveRes.headers.get('Content-Security-Policy'))}`,
    );
    // Issue #1366 (P6'-b token fallback): the raw response now also
    // carries Cache-Control: no-store, closing the browser-cache bypass
    // of the viewer token's single-use property.
    expect(
      serveRes.headers.get('Cache-Control') === 'no-store',
      "V3 serve: Cache-Control header is 'no-store' (Issue #1366)",
      `observed=${JSON.stringify(serveRes.headers.get('Cache-Control'))}`,
    );
    await serveRes.text();

    // New coverage (P6, navigation jail): the SAME raw endpoint, without
    // Sec-Fetch-Dest: iframe, must redirect to the viewer shell rather than
    // ever serving bytes at the top level -- the fail-closed default that
    // makes the header's absence safe. Real HTTP round trip against the
    // real disposable server, `redirect: 'manual'` so this script observes
    // the 302 itself instead of `fetch()` transparently following it.
    const topLevelServeRes = await fetch(artifactUrl, { headers: { Cookie: cookieHeader }, redirect: 'manual' });
    expect(
      topLevelServeRes.status === 302 || topLevelServeRes.type === 'opaqueredirect',
      'V3 P6: GET /api/artifacts/:id WITHOUT Sec-Fetch-Dest: iframe redirects instead of serving bytes',
      `status=${topLevelServeRes.status}, type=${topLevelServeRes.type}`,
    );
    if (topLevelServeRes.status === 302) {
      expect(
        topLevelServeRes.headers.get('Location') === toolResult.path,
        'V3 P6: the redirect Location is the viewer shell path returned by the tool result',
        `Location=${topLevelServeRes.headers.get('Location')}, expected=${toolResult.path}`,
      );
    }

    const listRes = await fetch(`${baseUrl}/api/artifacts`, { headers: { Cookie: cookieHeader } });
    expect(listRes.status === 200, 'V3 list: GET /api/artifacts is HTTP 200', `status=${listRes.status}`);
    const listBody = await listRes.json();
    const listedIds = (listBody.artifacts ?? []).map((a) => a.id);
    expect(
      listedIds.includes(artifactId),
      'V3 list: the created artifact is present in GET /api/artifacts',
      `listedIds=${JSON.stringify(listedIds)}`,
    );

    const deleteRes = await fetch(artifactUrl, { method: 'DELETE', headers: { Cookie: cookieHeader } });
    expect(deleteRes.status === 200, 'V3 delete: DELETE /api/artifacts/:id is HTTP 200', `status=${deleteRes.status}`);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success === true, 'V3 delete: response body reports success:true', JSON.stringify(deleteBody));

    // Direct filesystem check: a route that deletes the DB row but leaks
    // the on-disk file would still pass the HTTP-only assertions above (the
    // route's own readArtifactFile lookup would 404 the SAME way whether
    // the DB row or the file is what's actually missing). Import the
    // production path-resolution helper directly (no manual replication)
    // so this check can never drift from what the server itself writes to.
    const { getArtifactFilePath } = await import('../../packages/server/src/lib/config.ts');
    const artifactFilePath = getArtifactFilePath(session.createdBy, artifactId);
    expect(
      !existsSync(artifactFilePath),
      'V3 delete: the backing artifact file is actually gone from disk (not just the DB row)',
      `artifactFilePath=${artifactFilePath}, existsSync=${existsSync(artifactFilePath)}`,
    );

    const serveAfterDeleteRes = await fetch(artifactUrl, {
      headers: { Cookie: cookieHeader, 'Sec-Fetch-Dest': 'iframe' },
    });
    expect(
      serveAfterDeleteRes.status === 404,
      'V3 serve-after-delete: GET /api/artifacts/:id is HTTP 404',
      `status=${serveAfterDeleteRes.status}`,
    );
    await serveAfterDeleteRes.text();
  } finally {
    if (sqliteHandle) {
      sqliteHandle.close();
    }
    // Best-effort shutdown of the in-process server + DB handle. No
    // exported shutdown hook is reachable from here (index.ts's
    // `appContext` is module-private, same as V1's script notes) -- this
    // script exits the whole process instead of a graceful in-place
    // teardown, acceptable for a short-lived disposable smoke script.
  }

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    cleanupAndExit(disposableHome, 1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed`);
  cleanupAndExit(disposableHome, 0);
}

/** Remove the disposable AGENT_CONSOLE_HOME tree (never rm -rf per the sandbox guard's convention) and exit. */
function cleanupAndExit(disposableHome, code) {
  try {
    rmSync(disposableHome, { recursive: true, force: true });
    console.log(`==> cleaned up disposable AGENT_CONSOLE_HOME: ${disposableHome}`);
  } catch (err) {
    console.error(`==> WARNING: failed to clean up ${disposableHome}: ${err}`);
  }
  process.exit(code);
}

// Guarded (Issue #1479): importing this module must not fire a billed run
// as a side effect. `import.meta.main` is false for an importer, true only
// when this file is the entry point.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`E2E FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (disposableHomeForCleanup) {
      cleanupAndExit(disposableHomeForCleanup, 2);
    } else {
      process.exit(2);
    }
  });
}
