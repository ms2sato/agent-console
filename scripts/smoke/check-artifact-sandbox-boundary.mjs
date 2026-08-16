#!/usr/bin/env bun
/**
 * Real-Chromium load-bearing probe for the HTML Artifacts CSP sandbox
 * boundary (Issue #1312, docs/design/html-artifacts.md §3 / §8, AC "V1").
 *
 * This is NOT a confirmatory regression test -- it is the ONLY thing that
 * proves premises P1 (the `sandbox` response-header directive produces an
 * opaque origin, even with `allow-scripts`, in a real browser) and P2 (the
 * `SameSite=Lax` auth cookie withholds itself from a same-origin fetch made
 * by that opaque-origin document) actually hold. Structural template:
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
 * 2. Mints a REAL authenticated session against that instance (see
 *    "CREDENTIAL-ISSUANCE SUBSTITUTION" below -- this is a recorded proxy
 *    per pre-pr-completeness.md Q13, not a bypass of anything this probe
 *    verifies).
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
 * AC also allows: it lets step 2 below reach into the *exact* `MultiUserMode`
 * class instance the running server uses via ordinary module-cache identity
 * (Bun's module cache keys by resolved absolute file path, not by the
 * import specifier string, so this script's
 * `import('../packages/server/src/services/user-mode.ts')` and
 * `app-context.ts`'s `import('./services/user-mode.js')` resolve to the
 * SAME cached module) -- no second SQLite connection, no IPC, no
 * subprocess-boundary credential smuggling.
 *
 * ============================================================================
 * CREDENTIAL-ISSUANCE SUBSTITUTION (pre-pr-completeness.md Q13)
 * ============================================================================
 *
 * V1's credentialed-fetch arm and both positive controls need a REAL
 * authenticated session (real user row, real signed JWT, real Set-Cookie
 * response with the production `SameSite=Lax` attribute) against a REAL
 * `AUTH_MODE=multi-user` instance -- P2 is specifically about SameSite,
 * which is a no-op to test in `AUTH_MODE=none` (see the AC's "critical
 * environment finding"). Multi-user login validates OS credentials
 * (`pamtester` on Linux) against a REAL password this script has no
 * legitimate way to obtain (no interactive terminal, and creating a new OS
 * account requires root + would violate
 * `.claude/rules/os-environment-coupling.md` Discipline 2 -- no unilateral
 * OS state changes outside the project's own scope, without owner consent).
 *
 * Per Q13's three conditions for a recorded proxy substitution:
 *
 *   1. Upstream and outside: `MultiUserMode.prototype.validateOsCredentials`
 *      is monkey-patched (at RUNTIME, in this script's own process only --
 *      zero repository files are modified) to resolve `true` unconditionally.
 *      This is the interactive-password-check step, which sits upstream of
 *      and entirely outside the CSP sandbox boundary chain this probe
 *      verifies (P1/P2 are about what an artifact document can and cannot
 *      do once loaded, not about how a user proves their password).
 *   2. Genuinely provisioned: every other step of `MultiUserMode.login()`
 *      runs FOR REAL and UNMODIFIED: `lookupOsUser()` does a real `id` /
 *      `getent` lookup of this script's own real OS user (`os.userInfo()`),
 *      `userRepository.upsertByOsUid()` performs a real INSERT against the
 *      disposable instance's real SQLite database, and the JWT is signed by
 *      the real `SignJWT` call with the real per-instance secret generated
 *      by `MultiUserMode.create()`. The resulting cookie is set via the
 *      real `POST /api/auth/login` route handler (`routes/auth.ts`,
 *      unmodified), with the real `SameSite=Lax` attribute this probe
 *      exists to verify.
 *   3. Recorded as a proxy, here and in the final run report (see the
 *      script's own log output at "CREDENTIAL ISSUANCE (proxy)").
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
 * against the real `Set-Cookie` header earlier in this script) plus a
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

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

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

/** Minimal Set-Cookie parser -- only the attributes this probe needs to verify. */
function parseSetCookie(setCookieHeader) {
  const parts = setCookieHeader.split(';').map((p) => p.trim());
  const [nameValue, ...attrParts] = parts;
  const eqIdx = nameValue.indexOf('=');
  const name = nameValue.slice(0, eqIdx);
  const value = nameValue.slice(eqIdx + 1);
  const attrs = { httpOnly: false, secure: false, sameSite: undefined, path: '/' };
  for (const attr of attrParts) {
    const lower = attr.toLowerCase();
    if (lower === 'httponly') attrs.httpOnly = true;
    else if (lower === 'secure') attrs.secure = true;
    else if (lower.startsWith('samesite=')) attrs.sameSite = attr.split('=')[1];
    else if (lower.startsWith('path=')) attrs.path = attr.split('=')[1];
  }
  return { name, value, ...attrs };
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
  // SameSite cookie omission) actually fires.
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
      setTimeout(function () {
        var formViolation = cspViolations.find(function (v) { return v.violatedDirective.indexOf('form-action') !== -1; });
        post('external-form-result', {
          navigatedAway: window.location.href.indexOf('example.com') !== -1,
          formActionViolationObserved: !!formViolation,
          cspViolations: cspViolations.slice(),
        });
      }, 500);
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
  process.env.HOST = '127.0.0.1';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  // CREDENTIAL-ISSUANCE SUBSTITUTION (see header comment): monkey-patch the
  // OS-password-check step ONLY, at runtime, in this process. Every other
  // step of MultiUserMode.login() (real OS user lookup, real DB upsert,
  // real JWT signing, real cookie attributes) runs unmodified.
  const userModeModule = await import('../../packages/server/src/services/user-mode.ts');
  const originalValidateOsCredentials = userModeModule.MultiUserMode.prototype.validateOsCredentials;
  userModeModule.MultiUserMode.prototype.validateOsCredentials = async () => true;
  console.log(
    '==> CREDENTIAL ISSUANCE (proxy): MultiUserMode.prototype.validateOsCredentials monkey-patched to bypass ' +
      'the interactive OS-password check ONLY (runtime-only, this process, zero repo files modified). ' +
      'lookupOsUser / upsertByOsUid / JWT signing / cookie issuance all run for real. See header comment ' +
      '"CREDENTIAL-ISSUANCE SUBSTITUTION" for the pre-pr-completeness.md Q13 justification.',
  );

  // SERVER-SIDE REQUEST OBSERVATION (arm 3 / connect-wall assertion, see
  // header comment "ARM 3"): monkey-patch the GLOBAL `Bun.serve` (at
  // RUNTIME, in this process only, zero repo files modified -- same style
  // as the CREDENTIAL-ISSUANCE SUBSTITUTION above) so every request the
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

  try {
    // -----------------------------------------------------------------
    // Real login: this script's own real OS user, real everything except
    // the password check (see CREDENTIAL-ISSUANCE SUBSTITUTION above).
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
    console.log(
      `==> real login succeeded for OS user '${osUsername}'; cookie attrs: SameSite=${authCookie.sameSite}, ` +
        `HttpOnly=${authCookie.httpOnly}, Secure=${authCookie.secure}`,
    );
    expect(
      authCookie.sameSite && authCookie.sameSite.toLowerCase() === 'lax',
      'auth cookie carries SameSite=Lax (premise P2 dependency)',
      `observed SameSite=${authCookie.sameSite}`,
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
      // Seed the real auth cookie into the browser's cookie jar for this
      // origin -- the SAME cookie routes/auth.ts issued via the real login
      // above, with its real SameSite/HttpOnly/Secure attributes intact.
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
          sameSite: authCookie.sameSite === 'Lax' ? 'Lax' : authCookie.sameSite === 'Strict' ? 'Strict' : 'None',
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
      // Real probe: harness parent page + iframe pointed at the REAL
      // artifact-serving endpoint over real HTTP.
      // ---------------------------------------------------------------
      console.log(`\n==> loading probe artifact via real HTTP: ${artifactUrl}`);
      const probePage = await context.newPage();
      // The harness wrapper page MUST be navigated to the disposable
      // server's OWN origin (not left at page.setContent()'s about:blank),
      // mirroring the production viewer page (`/artifacts/:id`), which
      // wraps the same-origin `<iframe src="/api/artifacts/:id">`. This is
      // not cosmetic: a SameSite=Lax cookie is withheld from a cross-site
      // SUBFRAME navigation (an iframe's own request is not a top-level
      // navigation, so Lax's top-level-navigation carve-out does not apply
      // to it) -- an about:blank parent makes the artifact iframe's own GET
      // cross-site and 401s before the probe script ever runs, which would
      // be a harness-design bug, not the P2 boundary this arm exists to
      // observe. `/health` is unauthenticated and same-origin, so it is a
      // safe, real, same-site anchor page to navigate to first.
      await probePage.goto(`${baseUrl}/health`);
      await probePage.evaluate(() => {
        window.__probeMessages = [];
        window.addEventListener('message', (e) => window.__probeMessages.push(e.data));
      });
      await probePage.evaluate((url) => {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        document.body.appendChild(iframe);
      }, artifactUrl);

      // Wait for all arms to report (form arm has its own 500ms internal
      // delay before posting; give generous headroom).
      await probePage.waitForTimeout(2000);
      const messages = await probePage.evaluate(() => window.__probeMessages);
      const byType = Object.fromEntries(messages.map((m) => [m.type, m.detail]));

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

      // Arm 5: external form POST (form-action 'none').
      const extFormResult = byType['external-form-result'];
      expect(!!extFormResult, 'arm 5: external-form-result message received');
      if (extFormResult) {
        expect(
          extFormResult.formActionViolationObserved === true || extFormResult.navigatedAway === false,
          'arm 5: external form POST is blocked (CSP form-action \'none\')',
          `detail=${JSON.stringify(extFormResult)}`,
        );
      }
      await probePage.close();

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
  } finally {
    // Best-effort shutdown of the in-process server + DB handle. There is
    // no exported shutdown hook reachable from here (index.ts's `appContext`
    // is module-private), so this script exits the whole process instead of
    // trying to tear the server down gracefully in place -- acceptable for
    // a short-lived, disposable, single-run smoke script.
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
  console.error(`PROBE FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (disposableHomeForCleanup) {
    cleanupAndExit(disposableHomeForCleanup, 2);
  } else {
    process.exit(2);
  }
});
