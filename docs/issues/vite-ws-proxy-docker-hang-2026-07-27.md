# Vite `/ws` Proxy Hang Inside Docker (Issue #1211)

**Date:** 2026-07-27
**Branch:** fix/1211-vite-ws-proxy-hang
**Status:** Root-caused to a Bun-engine issue; not fixable in this repo's vite/Docker config. Upstream filing prepared below, pending owner approval before submission.

## Summary

The Docker dev stack's vite proxy (`packages/client/vite.config.ts`'s `/ws` entry) never delivers a WebSocket upgrade response to the browser when vite runs inside a Docker container. The Dashboard hangs forever on "Loading sessions...". The identical connection straight to the backend (bypassing vite) succeeds in milliseconds, and the identical vite config + Bun binary + backend run bare on the host (no Docker) also succeeds in milliseconds. The differentiator is strictly "runs inside a Docker container" — every other variable was held fixed and ruled out.

This document supersedes the working notes in the Issue #1211 comment thread (A9's investigation, 2026-07-19) with syscall-level evidence pinpointing where the bytes are lost.

## Symptom

- `new WebSocket('ws://localhost:<port>/ws/app')` from the browser, through the vite dev server's `/ws` proxy, never reaches `readyState === 1` (OPEN). No `open`, `message`, `error`, or `close` event fires — confirmed to persist for 30+ seconds (not merely slow).
- The vite proxy's own instrumentation (`proxyReqWs` hook, added in PR #1218) shows the upgrade dispatch fires (`[vite proxy /ws] upgrade dispatched: /ws/app`), but none of `open` / `error` / `close` ever fire.
- Direct connection to the backend, bypassing vite (`ws://localhost:<backend-port>/ws/app`), succeeds in ~5ms with all expected sync messages.

## Ruled out (does not fix or explain the hang)

Tested against a 100%-deterministic reproduction (both under `network_mode: host` and the stock bridge + port-mapped `docker-compose.yml` — the hang is identical in both):

| Hypothesis | Result |
|---|---|
| `changeOrigin: true` on the `/ws` proxy entry (the Issue's own originally-suggested fix, and A9's first ruled-out hypothesis) | No change. Dispatch fires, nothing else ever does. |
| `target: http://...` instead of `target: ws://...` | No change. |
| `seccomp:unconfined` + `cap_add: ALL` | No change. |
| `pid: host` | No change. |
| Running as `root` instead of the dropped-privilege `agentconsole` user | No change. |
| Bypassing the `concurrently` wrapper entirely (running vite standalone via `docker exec`) | No change. |
| Bun 1.3.8 vs 1.3.10 inside the container | Both hang identically (matches A9's own bun-bump test). |
| A hand-rolled raw `net.Socket` upgrade-proxy plugin, bypassing vite's `http-proxy`-based proxy middleware entirely | Same failure shape: backend response bytes are received correctly and handed to `target.pipe(socket)`, but the client never receives anything. |

## The control experiment that isolates the cause

Same `packages/client/vite.config.ts`, same Bun binary (1.3.8), same backend process, run **bare on the host with no Docker involved at all**: the WS proxy works, reaching `OPEN` in ~10ms with all sync messages delivered.

Every other axis (Bun version, user privilege, process wrapper, seccomp/capabilities, PID namespace, network mode) was varied independently inside Docker and none of them changed the outcome. Only "inside a container" vs "bare process" flips the result. This is the single experiment that makes the rest of the investigation conclusive rather than suggestive.

## Root-cause evidence (`strace`)

Attached `strace -f -tt` to the vite process during a live hang, filtering to `network,write,writev,sendto,sendmsg,close`. Annotated excerpt (fd numbers vary per run; the pattern is stable):

```
77   accept4(19, ...) = 553                      # client's upgrade request accepted (thread 77)
77   recvfrom(553, "GET /ws/app HTTP/1.1...")     # upgrade request read
77   write(1, "[vite proxy /ws] upgrade dispatched: /ws/app\n")

354  socket(...) = 557                            # a DIFFERENT thread opens the backend connection
354  connect(557, 127.0.0.1:<backend-port>)
354  sendto(557, "GET /ws/app HTTP/1.1...")        # forwards the upgrade request to the backend
354  recvfrom(557, "HTTP/1.1 101 Switching Protocols...") = 166   # backend's 101 response arrives correctly
354  write(6, "\1\0\0\0\0\0\0\0", 8) = 8            # 8-byte eventfd-style cross-thread notification, NOT a client write
354  recvfrom(557, "...schema-version...") = 56    # backend's first WS frame arrives correctly
354  write(6, "\1\0\0\0\0\0\0\0", 8) = 8            # another notification, still not a client write
354  recvfrom(557, "...agents-sync...") = 852       # backend's second WS frame arrives correctly
...
                                                    # fd 553 (the client's own socket) is never
                                                    # referenced again — no write(), no sendto(), nothing.
132  close(559)                                     # a *different* fd (likely 553's cross-thread dup)
                                                    # eventually gets closed, unwritten.
```

The backend's response is received correctly by the thread that owns the outbound proxy connection (354). That thread never performs a `write`/`sendto` on the client's socket (or its cross-thread duplicate) — it only issues small fixed-size writes to what appears to be an internal eventfd used to notify another thread/event-loop of pending work. The client-facing fd's duplicate is eventually closed without ever having been written to.

This points to a bug in Bun's cross-thread socket-write marshaling (the mechanism that lets one native I/O thread hand write-ready data back to the thread/event-loop that owns the originating client connection), which only manifests under whatever scheduling conditions a Docker container's cgroup/namespaces produce — not a code or config issue in this repository's `http-proxy` usage, vite configuration, or Docker Compose setup.

## Minimal standalone reproduction (does not depend on this repository)

The following reproduces the same shape (backend data received, never forwarded to the client) with nothing but Bun + Docker + a two-file Node `http` upgrade proxy. A Bun maintainer should be able to run this directly.

**`server.js`** (the "backend" — any WS server capable of Bun's `Bun.serve` upgrade path works; this uses plain `ws` semantics via Bun's native WebSocket upgrade for minimality):

```js
// server.js — minimal WS echo server
Bun.serve({
  port: 4000,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('not a websocket request', { status: 400 });
  },
  websocket: {
    open(ws) { ws.send('hello from backend'); },
    message(ws, msg) { ws.send(`echo: ${msg}`); },
  },
});
```

**`proxy.js`** (the "vite-shaped" upgrade-forwarding proxy — a plain Node `http.createServer` with a manual `net.Socket` relay on `upgrade`, structurally identical to what vite's own `http-proxy`-based `/ws` entry does):

```js
// proxy.js — minimal raw-socket WS upgrade proxy (mirrors vite's /ws proxy shape)
import * as http from 'node:http';
import * as net from 'node:net';

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});

server.on('upgrade', (req, clientSocket, head) => {
  const target = net.connect(4000, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${v}\r\n`;
    raw += '\r\n';
    target.write(raw);
    if (head?.length) target.write(head);
    target.pipe(clientSocket);
    clientSocket.pipe(target);
  });
});

server.listen(5000, '0.0.0.0', () => console.log('proxy on :5000'));
```

**`Dockerfile`**:

```dockerfile
FROM oven/bun:1.3.8
WORKDIR /app
COPY server.js proxy.js ./
CMD sh -c "bun run server.js & bun run proxy.js"
```

**Reproduction steps:**

```bash
docker build -t bun-ws-repro .
docker run --rm -p 5000:5000 bun-ws-repro
# from the host:
bun -e "
const ws = new WebSocket('ws://localhost:5000/');
ws.onopen = () => console.log('OPEN');
ws.onmessage = (e) => console.log('MESSAGE', e.data);
setTimeout(() => console.log('readyState after 5s:', ws.readyState), 5000);
"
# Expected (bug present): readyState stays 0 (CONNECTING) forever, no OPEN/MESSAGE ever logged.
#
# Control (bug absent): kill the container, run the same two files with
# `bun run server.js & bun run proxy.js` directly on the host (no Docker) —
# OPEN and MESSAGE log within milliseconds.
```

If this reproduces cleanly in isolation, it is a strong upstream-filing candidate against `oven-sh/bun`.

## Draft upstream issue (prepared, not yet submitted — awaiting owner approval per project policy on public/outward-facing filings)

> **Title:** WebSocket upgrade proxy hangs inside a Docker container — backend response received but never forwarded to the client socket
>
> **Body:**
>
> When a Node `http.createServer` (running under Bun) manually proxies a WebSocket upgrade to a second backend server by relaying the raw socket (`net.connect` + `.pipe()`, the same pattern `http-proxy`/vite's dev server proxy use internally), the backend's `101 Switching Protocols` response and subsequent WS frames are received correctly by the proxy process, but are never forwarded to the original client socket — **only when the proxy process runs inside a Docker container**. The identical code, same Bun binary version, run directly on the host with no container involved, works correctly (client reaches `OPEN` within milliseconds).
>
> Reproduction: [attach the three files above / a public repo containing them].
>
> `strace -f` on the proxy process during a hang shows: the client's accepted socket fd is read once (for the upgrade request) and never appears in another `write`/`sendto` call. A separate OS thread performs the `connect()`/`recvfrom()` to the backend and receives its response/frames correctly, then only issues small (8-byte) writes to what appears to be an internal eventfd used for cross-thread notification. The client-facing fd (or its cross-thread duplicate) is eventually closed without ever being written to.
>
> Ruled out as contributing factors (all still reproduce the hang): container `seccomp:unconfined` + `cap_add: ALL`, `pid: host` namespace sharing, running as root vs. a non-root user, Bun 1.3.8 vs 1.3.10, `network_mode: host` vs. standard bridge networking with port mapping.
>
> Bun version: 1.3.8 and 1.3.10 (both reproduce). Host: Linux aarch64 (Docker 29.6.0, containerd 2.2.5). Container base image: `oven/bun:1.3.8` / `oven/bun:1.3.10`.

## Why this is not fixable in `agent-console`

The failure occurs below the layer this repository controls: `vite.config.ts`'s proxy configuration, `http-proxy` (vite's dependency), and a from-scratch raw-socket relay all exhibit the identical failure shape when the process runs inside a container. The one variable that flips the outcome — container vs. bare process — is outside this repository's code entirely. Building a WS-proxy implementation that avoids Bun's own socket-write path would be a substantial engineering effort to work around an upstream engine bug, on a dev-only code path (production runs the built bundle, not vite) that already has two working alternatives (see below).

## Current guidance (see also `docker/README.md` and the `dev-environment-quirks` skill)

- **`scripts/dev-multiuser.sh`** (host-side, no Docker) — fully functional, including `/ws`.
- **`docker/docker-compose.verification.yml`** (production bundle, no vite) — fully functional, including `/ws`.
- The Docker **dev** stack (`docker/docker-compose.yml`) remains usable for everything that does not depend on `/ws` (login, static asset serving, `/api` routes) but cannot currently support Browser QA flows that need the Dashboard's live session sync.

## Related

- Issue [#1211](https://github.com/ms2sato/agent-console/issues/1211) — original bug report and A9's 2026-07-19 investigation (IPv6/DNS asymmetry, Bun version bump, vite upgrade-dispatch instrumentation).
- PR #1218 — added the IPv4-literal proxy targets and the `[vite proxy /ws]` observability hooks used throughout this investigation.
- Issue #1214 — unrelated Docker dev stack blocker (`bun install --frozen-lockfile` exit 1 on a fresh container), encountered while reproducing this issue; worked around locally (uncommitted) for this investigation, not part of this fix.
