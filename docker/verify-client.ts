#!/usr/bin/env bun
/**
 * Multi-user PTY identity-isolation probe.
 *
 * Drives the real shipping path end to end for one OS user:
 *   login -> create quick session -> create terminal worker -> open worker WS
 *   -> run `whoami` in the PTY -> assert the PTY runs as that OS user.
 *
 * The terminal echoes the command we type, and the shell prompt may itself
 * contain the username, so we cannot just grep for the bare username. Instead we
 * print a unique marker line `ACUSER:<whoami>` and assert on that — the echoed
 * input contains the literal `$(whoami)`, never the expanded value, so a
 * `ACUSER:<user>` line can only come from the command actually executing as
 * <user>.
 *
 * Usage: bun docker/verify-client.ts <baseUrl> <username> <password> <expectedUser> <locationPath>
 * Exit code 0 on success, 1 on failure. Prints a one-line RESULT summary.
 */

const [, , baseUrl, username, password, expectedUser, locationPath] = Bun.argv;

if (!baseUrl || !username || !password || !expectedUser || !locationPath) {
  console.error('usage: bun verify-client.ts <baseUrl> <username> <password> <expectedUser> <locationPath>');
  process.exit(2);
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

// 2. Create a quick session owned by this user (createdBy resolves to the user).
const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ type: 'quick', locationPath, title: `verify-${username}` }),
});
if (sessionRes.status !== 201) {
  fail(`create session returned HTTP ${sessionRes.status}: ${await sessionRes.text()}`);
}
const sessionId = (await sessionRes.json()).session.id as string;

// 3. Create a terminal worker (spawns `sudo -u <user> -i sh -c 'exec $SHELL -l'`).
const workerRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workers`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ type: 'terminal' }),
});
if (workerRes.status !== 201) {
  fail(`create worker returned HTTP ${workerRes.status}: ${await workerRes.text()}`);
}
const workerId = (await workerRes.json()).worker.id as string;

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
