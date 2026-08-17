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
 * boot / credential-issuance-substitution login / MCP JSON-RPC helpers.
 * Deliberate: V1's script is an already-verified, load-bearing security
 * probe; extracting a shared module at this second consumer would touch
 * (and risk destabilizing) a file this round was told not to touch. This
 * repo's convention is "duplicate once, extract at the second real
 * consumer" -- the bias here is toward NOT touching V1's file at all,
 * which the extraction path cannot guarantee. See V1's script for the full
 * rationale on each piece (in-process import for module-cache identity,
 * the Q13 credential-issuance substitution, etc.) -- not re-derived here,
 * only the parts relevant to V2/V3 are repeated.
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

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

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

/** Minimal Set-Cookie parser -- only the attributes this script needs. */
function parseSetCookie(setCookieHeader) {
  const parts = setCookieHeader.split(';').map((p) => p.trim());
  const [nameValue] = parts;
  const eqIdx = nameValue.indexOf('=');
  const name = nameValue.slice(0, eqIdx);
  const value = nameValue.slice(eqIdx + 1);
  return { name, value };
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

  // CREDENTIAL-ISSUANCE SUBSTITUTION (pre-pr-completeness.md Q13), same
  // proxy V1's script uses and justifies at length: only the interactive
  // OS-password check is bypassed, at runtime, in this process, zero repo
  // files modified. Real OS user lookup, real DB upsert, real JWT
  // signing, real cookie issuance all run unmodified.
  const userModeModule = await import('../../packages/server/src/services/user-mode.ts');
  userModeModule.MultiUserMode.prototype.validateOsCredentials = async () => true;
  console.log(
    '==> CREDENTIAL ISSUANCE (proxy): MultiUserMode.prototype.validateOsCredentials monkey-patched to bypass ' +
      'the interactive OS-password check ONLY (runtime-only, this process, zero repo files modified). See ' +
      'check-artifact-sandbox-boundary.mjs header comment "CREDENTIAL-ISSUANCE SUBSTITUTION" for the full ' +
      'pre-pr-completeness.md Q13 justification (identical substitution, reused here).',
  );

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
    // Real login.
    // -----------------------------------------------------------------
    const osUsername = os.userInfo().username;
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: osUsername, password: 'unused-password-check-is-bypassed' }),
    });
    if (!loginRes.ok) {
      throw new Error(`Login failed unexpectedly (status ${loginRes.status}): ${await loginRes.text()}`);
    }
    const setCookieHeader = loginRes.headers.get('set-cookie');
    if (!setCookieHeader) {
      throw new Error('Login succeeded but no Set-Cookie header was returned');
    }
    const authCookie = parseSetCookie(setCookieHeader);
    const cookieHeader = `${authCookie.name}=${authCookie.value}`;
    console.log(`==> real login succeeded for OS user '${osUsername}'`);

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

main().catch((err) => {
  console.error(`E2E FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (disposableHomeForCleanup) {
    cleanupAndExit(disposableHomeForCleanup, 2);
  } else {
    process.exit(2);
  }
});
