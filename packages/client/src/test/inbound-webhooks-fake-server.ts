/**
 * A small stateful fake of the endpoints the inbound webhook pages call, at
 * the `fetch` level (the Hono RPC client and raw fetch both resolve to
 * `globalThis.fetch`). Shared by the page, dialog and hook tests.
 */
import { mock } from 'bun:test';
import type { InboundWebhookEndpoint } from '@agent-console/shared';

export const FAKE_REPOSITORY = {
  id: 'repo-1',
  name: 'my-repo',
  path: '/repos/my-repo',
  createdAt: '2026-01-01T00:00:00Z',
  orchestratorSessionIds: [],
  clonedSourceRepoPath: null,
};

export function makeEndpoint(overrides: Partial<InboundWebhookEndpoint> = {}): InboundWebhookEndpoint {
  return {
    id: 'ep-1',
    label: 'Slack alerts',
    repositoryId: 'repo-1',
    instructionText: 'Triage the message',
    hasPreviousSecret: false,
    previousSecretExpiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export interface FakeCall {
  method: string;
  url: string;
  body: unknown;
}

export interface FakeServer {
  endpoints: InboundWebhookEndpoint[];
  internetOrigin: string | null;
  listStatus: number;
  /** When set, a create request does not answer until this resolves. */
  createGate: Promise<void> | null;
  /** When set, a rotate request does not answer until this resolves. */
  rotateGate: Promise<void> | null;
  /** When set, create, update and rotate answer 4xx with this error message. */
  failWith: string | null;
  calls: FakeCall[];
  mockFetch: ReturnType<typeof mock>;
  restore: () => void;
  reset: () => void;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = input instanceof Request ? await input.clone().text() : (init?.body as string | undefined);
  return raw ? JSON.parse(raw) : undefined;
}

export function installFakeServer(): FakeServer {
  const originalFetch = globalThis.fetch;
  const server = {} as FakeServer;

  server.reset = () => {
    server.endpoints = [makeEndpoint()];
    server.internetOrigin = 'https://hooks.example.com';
    server.listStatus = 200;
    server.createGate = null;
    server.rotateGate = null;
    server.failWith = null;
    server.calls = [];
  };
  server.reset();

  server.mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (input instanceof Request ? input.method : (init?.method ?? 'GET')).toUpperCase();
    const path = new URL(url, 'http://localhost').pathname;

    if (path === '/api/system/health') {
      return jsonResponse({ webhookSecretConfigured: true, appUrl: null, internetOrigin: server.internetOrigin });
    }
    if (method === 'GET' && path === '/api/repositories/repo-1') {
      return jsonResponse({ repository: FAKE_REPOSITORY });
    }

    const match = path.match(/^\/api\/repositories\/repo-1\/inbound-webhook-endpoints(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!match) return jsonResponse({}, 404);
    const [, id, action] = match;
    const body = await readBody(input, init);
    server.calls.push({ method, url: path, body });

    if (method === 'GET' && !id) {
      if (server.listStatus !== 200) return jsonResponse({ error: 'boom' }, server.listStatus);
      return jsonResponse({ endpoints: server.endpoints });
    }
    if (method === 'GET' && id) {
      const found = server.endpoints.find((e) => e.id === id);
      return found ? jsonResponse({ endpoint: found }) : jsonResponse({ error: 'not found' }, 404);
    }
    if (server.failWith && (method === 'POST' || method === 'PATCH')) {
      return jsonResponse({ error: server.failWith }, 404);
    }
    if (method === 'POST' && !id) {
      if (server.createGate) await server.createGate;
      const request = body as { label: string; instructionText: string; secret?: string };
      const created = makeEndpoint({ id: 'ep-new', label: request.label, instructionText: request.instructionText });
      server.endpoints = [...server.endpoints, created];
      return request.secret === undefined
        ? jsonResponse({ endpoint: created, secretSource: 'generated', secret: 'whsec_generated' }, 201)
        : jsonResponse({ endpoint: created, secretSource: 'entered' }, 201);
    }
    if (method === 'POST' && action === 'rotate-secret') {
      if (server.rotateGate) await server.rotateGate;
      server.endpoints = server.endpoints.map((e) =>
        e.id === id ? { ...e, hasPreviousSecret: true, previousSecretExpiresAt: '2099-01-02T00:00:00.000Z' } : e,
      );
      const rotated = server.endpoints.find((e) => e.id === id);
      const request = (body ?? {}) as { secret?: string };
      return request.secret === undefined
        ? jsonResponse({ endpoint: rotated, secretSource: 'generated', secret: id === 'ep-1' ? 'whsec_rotated' : `whsec_rotated_${id}` })
        : jsonResponse({ endpoint: rotated, secretSource: 'entered' });
    }
    if (method === 'POST' && action === 'clear-previous-secret') {
      server.endpoints = server.endpoints.map((e) =>
        e.id === id ? { ...e, hasPreviousSecret: false, previousSecretExpiresAt: null } : e,
      );
      return jsonResponse({ endpoint: server.endpoints.find((e) => e.id === id) });
    }
    if (method === 'PATCH' && id) {
      server.endpoints = server.endpoints.map((e) => (e.id === id ? { ...e, ...(body as object) } : e));
      return jsonResponse({ endpoint: server.endpoints.find((e) => e.id === id) });
    }
    if (method === 'DELETE' && id) {
      server.endpoints = server.endpoints.filter((e) => e.id !== id);
      return jsonResponse({ success: true });
    }
    return jsonResponse({}, 404);
  });

  globalThis.fetch = Object.assign(server.mockFetch, { preconnect: () => {} }) as typeof fetch;
  server.restore = () => {
    globalThis.fetch = originalFetch;
  };
  return server;
}
