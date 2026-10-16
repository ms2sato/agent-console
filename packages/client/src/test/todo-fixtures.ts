import { mock } from 'bun:test';
import type { Todo } from '@agent-console/shared';

/** A wire-valid `Todo` with overrides, shared by the to-do list tests. */
export function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-1',
    kind: 'action',
    scope: 'session',
    title: 'Run the migration',
    body: '',
    sessionId: 'session-1',
    createdBy: { workerId: 'worker-1' },
    assigneeUserId: null,
    status: 'open',
    resolutionText: null,
    resolvedByUserId: null,
    resolvedByWorkerId: null,
    resolvedAt: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function fetchUrl(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

export interface RecordedCall {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

export interface DirectoryUserFixture {
  id: string;
  username: string;
}

/**
 * A fetch-level stand-in for the to-do and user-directory endpoints. Reads
 * answer from `todos` / `users`; every write is recorded and answered with the
 * item it names (or with `refusal` when one is set), so a test asserts what
 * the UI SENT and what it SHOWS, never what a mocked module returned.
 */
export function createTodoApiMock() {
  const state = {
    todos: [] as Todo[],
    users: [{ id: 'user-me', username: 'me' }] as DirectoryUserFixture[],
    refusal: null as { status: number; error: string } | null,
    calls: [] as RecordedCall[],
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : fetchUrl(input), 'http://localhost');
    const method = (request ? request.method : init?.method) ?? 'GET';
    let body: unknown;
    const raw = request ? await request.clone().text() : init?.body;
    if (typeof raw === 'string' && raw !== '') body = JSON.parse(raw);

    if (url.pathname === '/api/users') {
      return jsonResponse({ users: state.users });
    }
    if (!url.pathname.startsWith('/api/todos')) {
      return jsonResponse({});
    }

    state.calls.push({ method, path: url.pathname, search: url.searchParams, body });
    if (method === 'GET') {
      const detailId = url.pathname.split('/')[3];
      if (detailId !== undefined) {
        const found = state.todos.find((todo) => todo.id === detailId);
        return found ? jsonResponse({ todo: found }) : jsonResponse({ error: 'Todo not found' }, 404);
      }
      return jsonResponse({ todos: state.todos });
    }
    if (state.refusal) {
      return jsonResponse({ error: state.refusal.error }, state.refusal.status);
    }
    if (method === 'DELETE') {
      return jsonResponse({ success: true });
    }
    const id = url.pathname.split('/')[3];
    const named = state.todos.find((todo) => todo.id === id);
    return jsonResponse({ todo: named ?? makeTodo({ id: id ?? 'created' }) }, method === 'POST' && !id ? 201 : 200);
  };

  const fetchMock = mock(fetchImpl);

  return {
    state,
    fetchMock,
    /** Installs the stand-in as global fetch and returns the restore function. */
    install(): () => void {
      const original = globalThis.fetch;
      globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} }) as typeof fetch;
      return () => {
        globalThis.fetch = original;
      };
    },
    /** The recorded write calls (everything but GET). */
    writes(): RecordedCall[] {
      return state.calls.filter((call) => call.method !== 'GET');
    },
    /** The recorded list fetches. */
    listFetches(): RecordedCall[] {
      return state.calls.filter((call) => call.method === 'GET');
    },
  };
}
