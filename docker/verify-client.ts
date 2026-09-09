#!/usr/bin/env bun
/**
 * Multi-user session/PTY probe.
 *
 * Drives the real shipping path end to end for one OS user, in one of three
 * modes:
 *
 *   1. PTY identity isolation: login -> create quick session -> create
 *      terminal worker -> open worker WS -> run `whoami` in the PTY ->
 *      assert the PTY runs as that OS user.
 *   2. `--attach`: skip session/worker creation and run the same PTY probe
 *      against an already-existing session/worker -> used to prove a second
 *      user can write into another user's (or a shared) session.
 *   3. `--list-session`: login -> open the app WS (`/ws/app`) -> wait for
 *      `sessions-sync` -> assert a given session id is present -> used to
 *      prove a second user can list a session (e.g. a shared session) that
 *      user did not create.
 *
 * The terminal echoes the command we type, and the shell prompt may itself
 * contain the username, so we cannot just grep for the bare username. Instead we
 * print a unique marker line `ACUSER:<whoami>` and assert on that — the echoed
 * input contains the literal `$(whoami)`, never the expanded value, so a
 * `ACUSER:<user>` line can only come from the command actually executing as
 * <user>.
 *
 * Usage:
 *   bun docker/verify-client.ts <baseUrl> <username> <password> <expectedUser> <locationPath> [--shared] [--print-ids]
 *   bun docker/verify-client.ts <baseUrl> <username> <password> <expectedUser> --attach <sessionId> <workerId>
 *   bun docker/verify-client.ts <baseUrl> <username> <password> --list-session <sessionId>
 *
 * `--shared` sends `shared: true` in the POST /api/sessions body (Issue #1619).
 * `--print-ids` prints `SESSION_ID=<id>` / `WORKER_ID=<id>` lines after
 * session/worker creation, before the probe runs — used by callers that need
 * to reuse the created session/worker for further checks. Omitted by default
 * so existing callers' output is unchanged.
 * `--attach <sessionId> <workerId>` skips session/worker creation and runs
 * the probe against an already-existing session/worker instead — used to
 * prove a second user can write into another user's (or a shared) session.
 * `--list-session <sessionId>` skips the PTY probe entirely and instead
 * asserts the session is visible over the app WebSocket's `sessions-sync`
 * frame (there is no `GET /api/sessions` collection route — session listing
 * is app-WS-only, see `packages/server/src/websocket/app-handler.ts`).
 *
 * Exit code 0 on success, 1 on failure, 2 on bad usage. Prints a one-line
 * RESULT summary.
 */

const argv = Bun.argv.slice(2);
const [baseUrl, username, password, fourthArg, ...rest] = argv;

function usageFail(): never {
  console.error(
    'usage: bun verify-client.ts <baseUrl> <username> <password> <expectedUser> <locationPath> [--shared] [--print-ids]\n' +
      '       bun verify-client.ts <baseUrl> <username> <password> <expectedUser> --attach <sessionId> <workerId>\n' +
      '       bun verify-client.ts <baseUrl> <username> <password> --list-session <sessionId>',
  );
  process.exit(2);
}

if (!baseUrl || !username || !password || !fourthArg) {
  usageFail();
}

// `--list-session` occupies the <expectedUser> slot; detect it before the
// existing <expectedUser>-based parsing below runs.
let listSessionId: string | undefined;
if (fourthArg === '--list-session') {
  const [sessionIdArg, ...extra] = rest;
  if (!sessionIdArg || extra.length > 0) {
    usageFail();
  }
  listSessionId = sessionIdArg;
}

const expectedUser = fourthArg;

let locationPath: string | undefined;
let shared = false;
let printIds = false;
let attach: { sessionId: string; workerId: string } | undefined;

if (listSessionId === undefined) {
  if (rest.length === 0) {
    usageFail();
  }
  if (rest[0] === '--attach') {
    const [, sessionId, workerId, ...extra] = rest;
    if (!sessionId || !workerId || extra.length > 0) {
      usageFail();
    }
    attach = { sessionId, workerId };
  } else {
    locationPath = rest[0];
    for (const flag of rest.slice(1)) {
      if (flag === '--shared') {
        shared = true;
      } else if (flag === '--print-ids') {
        printIds = true;
      } else {
        usageFail();
      }
    }
    if (!locationPath) {
      usageFail();
    }
  }
}

const MARKER = 'ACUSER:';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function fail(msg: string): never {
  console.log(`RESULT ${username}: FAIL — ${msg}`);
  process.exit(1);
}

// 1. Login and capture the auth_token cookie from Set-Cookie.
const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!loginRes.ok) {
  fail(`login returned HTTP ${loginRes.status}`);
}
const setCookies = typeof loginRes.headers.getSetCookie === 'function'
  ? loginRes.headers.getSetCookie()
  : [loginRes.headers.get('set-cookie') ?? ''].filter(Boolean);
const tokenCookie = setCookies.find((c) => c.includes('auth_token='));
if (!tokenCookie) {
  fail('login succeeded but no auth_token cookie was set');
}
// Extract just the "auth_token=<jwt>" pair, dropping cookie attributes.
const match = tokenCookie!.match(/auth_token=[^;]+/);
const cookie = match ? match[0] : tokenCookie!.split(';')[0];

const authHeaders = { 'Content-Type': 'application/json', Cookie: cookie };

if (listSessionId !== undefined) {
  // There is no `GET /api/sessions` collection route; the app WebSocket's
  // unprompted `sessions-sync` frame is the actual session-listing surface
  // (see `packages/server/src/websocket/app-handler.ts`).
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const wsUrl = `${wsBase}/ws/app`;
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } } as unknown as string[]);

  const result: Promise<{ ok: boolean; detail: string }> = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, detail: 'timed out waiting for sessions-sync' });
    }, 10_000);

    ws.addEventListener('message', (ev) => {
      let msg: { type?: string; sessions?: Array<{ id?: string }> };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      // Ignore other frames sent on open (schema-version, agents-sync,
      // repositories-sync, ...) and wait for sessions-sync specifically.
      if (msg.type !== 'sessions-sync') return;
      const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      clearTimeout(timeout);
      const found = sessions.some((s) => s?.id === listSessionId);
      resolve({
        ok: found,
        detail: `sessions-sync listed ${sessions.length} session(s); ${listSessionId} ${found ? 'present' : 'not present'}`,
      });
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false, detail: 'websocket error' });
    });
  });

  const { ok, detail } = await result;
  try {
    ws.close();
  } catch {
    // ignore
  }

  if (ok) {
    console.log(`RESULT ${username}: PASS — ${detail}`);
    process.exit(0);
  } else {
    fail(detail);
  }
}

let sessionId: string;
let workerId: string;

if (attach) {
  sessionId = attach.sessionId;
  workerId = attach.workerId;
} else {
  // 2. Create a quick session owned by this user (createdBy resolves to the
  //    user, unless --shared routes createdBy to the shared account instead).
  const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      type: 'quick',
      locationPath,
      title: `verify-${username}`,
      ...(shared ? { shared: true } : {}),
    }),
  });
  if (sessionRes.status !== 201) {
    fail(`create session returned HTTP ${sessionRes.status}: ${await sessionRes.text()}`);
  }
  sessionId = (await sessionRes.json()).session.id as string;

  // 3. Create a terminal worker (spawns `sudo -u <user> -i sh -c 'exec $SHELL -l'`).
  const workerRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workers`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'terminal' }),
  });
  if (workerRes.status !== 201) {
    fail(`create worker returned HTTP ${workerRes.status}: ${await workerRes.text()}`);
  }
  workerId = (await workerRes.json()).worker.id as string;

  if (printIds) {
    console.log(`SESSION_ID=${sessionId}`);
    console.log(`WORKER_ID=${workerId}`);
  }
}

// 4. Open the worker WebSocket and run the probe command.
const wsBase = baseUrl.replace(/^http/, 'ws');
const wsUrl = `${wsBase}/ws/session/${sessionId}/worker/${workerId}`;
const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } } as unknown as string[]);

const probe = `printf '${MARKER}%s\\n' "$(whoami)"\n`;
let buffer = '';

const result: Promise<{ ok: boolean; detail: string }> = new Promise((resolve) => {
  const timeout = setTimeout(() => {
    resolve({ ok: false, detail: `timed out; last output: ${JSON.stringify(buffer.slice(-200))}` });
  }, 10_000);

  let sent = false;
  const sendProbe = () => {
    if (sent) return;
    sent = true;
    ws.send(JSON.stringify({ type: 'input', data: probe }));
  };

  ws.addEventListener('open', () => {
    // Give the login shell a moment to initialize before typing.
    setTimeout(sendProbe, 800);
    // Retry once in case the first keystrokes raced the shell startup.
    setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: probe })), 3000);
  });

  ws.addEventListener('message', (ev) => {
    let msg: { type?: string; data?: string };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg.type === 'output' && typeof msg.data === 'string') {
      buffer += msg.data;
      const clean = buffer.replace(ANSI, '');
      const line = clean.split(/\r?\n/).find((l) => l.includes(MARKER) && !l.includes('$(whoami)'));
      if (line) {
        const actual = line.slice(line.indexOf(MARKER) + MARKER.length).trim();
        clearTimeout(timeout);
        resolve({
          ok: actual === expectedUser,
          detail: `whoami => '${actual}' (expected '${expectedUser}')`,
        });
      }
    }
  });

  ws.addEventListener('error', () => {
    clearTimeout(timeout);
    resolve({ ok: false, detail: 'websocket error' });
  });
});

const { ok, detail } = await result;
try {
  ws.close();
} catch {
  // ignore
}

if (ok) {
  console.log(`RESULT ${username}: PASS — ${detail}`);
  process.exit(0);
} else {
  fail(detail);
}
