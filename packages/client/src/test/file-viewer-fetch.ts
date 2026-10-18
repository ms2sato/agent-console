import { mock } from 'bun:test';
import type { FileContentResponse, FileTreeEntry } from '@agent-console/shared';

/** A route answer: a body, or a failure carrying the route's `error` message. */
type Answer<T> = T | { failure: { status: number; error: string } };

export interface FileViewerFetchRoutes {
  /** Directory path ('' = root) -> its entries. */
  tree?: Record<string, Answer<FileTreeEntry[]>>;
  /** File path -> its content response. */
  content?: Record<string, Answer<FileContentResponse>>;
}

export interface FileViewerFetchCall {
  route: 'tree' | 'content';
  path: string;
}

function isFailure<T>(answer: Answer<T>): answer is { failure: { status: number; error: string } } {
  return typeof answer === 'object' && answer !== null && 'failure' in answer;
}

/**
 * A `fetch` stand-in for the two file viewer routes, recording every call.
 * `routes` is read on each call, so a test may mutate it between actions.
 */
export function createFileViewerFetch(routes: FileViewerFetchRoutes) {
  const calls: FileViewerFetchCall[] = [];
  const holds = new Map<string, Promise<void>>();
  const fetchMock = mock(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const match = /\/files\/(tree|content)$/.exec(url.pathname);
    if (!match) return new Response('Not Found', { status: 404 });
    const route = match[1] as 'tree' | 'content';
    const path = url.searchParams.get('path') ?? '';
    calls.push({ route, path });
    await holds.get(`${route}:${path}`);

    const answer = route === 'tree' ? routes.tree?.[path] : routes.content?.[path];
    if (answer === undefined) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }
    if (isFailure(answer)) {
      return new Response(JSON.stringify({ error: answer.failure.error }), { status: answer.failure.status });
    }
    const body = route === 'tree' ? { path, entries: answer } : answer;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  /**
   * Holds the answer to one route+path until the returned function is called,
   * so a test can finish other actions while that request is still in flight.
   */
  function hold(route: 'tree' | 'content', path: string): () => void {
    let release = () => {};
    holds.set(`${route}:${path}`, new Promise<void>((resolve) => { release = resolve; }));
    return release;
  }
  return { fetchMock, calls, hold };
}

export function textFile(path: string, content: string, overrides: Partial<FileContentResponse> = {}): FileContentResponse {
  return {
    path,
    kind: 'text',
    content,
    size: new TextEncoder().encode(content).length,
    truncated: false,
    language: 'text',
    ...overrides,
  };
}
