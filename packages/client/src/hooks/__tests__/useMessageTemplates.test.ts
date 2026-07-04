import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { MessageTemplate } from '@agent-console/shared';

// --- Fetch-level API mocking (no mock.module; testing.md Anti-Pattern #2). ---
// bun's mock.module is process-global and would poison lib/api for sibling test
// files that consume the real module (MessagePanel/TerminalAdapter). Mock the
// communication layer instead and assert on the recorded fetch calls.
let templatesResponse: { templates: MessageTemplate[] } = { templates: [] };
const fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SAMPLE_TEMPLATE: MessageTemplate = {
  id: '1',
  title: 'Test',
  content: 'content',
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
};

function templatesFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  fetchCalls.push({ url, method, body: init?.body });
  if (url.endsWith('/api/message-templates') && method === 'GET') return Promise.resolve(jsonResponse(templatesResponse));
  if (url.endsWith('/api/message-templates') && method === 'POST') return Promise.resolve(jsonResponse({ template: SAMPLE_TEMPLATE }));
  if (url.endsWith('/api/message-templates/reorder')) return Promise.resolve(jsonResponse({ success: true }));
  if (/\/api\/message-templates\/[^/]+$/.test(url) && method === 'PUT') return Promise.resolve(jsonResponse({ template: SAMPLE_TEMPLATE }));
  if (/\/api\/message-templates\/[^/]+$/.test(url) && method === 'DELETE') return Promise.resolve(jsonResponse({ success: true }));
  return Promise.resolve(new Response('null', { status: 404 }));
}

/** Body-parsing helpers for the recorded fetch calls (all bodies are JSON strings). */
function jsonBody(body: unknown): Record<string, unknown> {
  return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : {};
}
function callsMatching(pattern: RegExp, method: string) {
  return fetchCalls.filter((c) => pattern.test(c.url) && c.method === method);
}

import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useMessageTemplates } from '../useMessageTemplates';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

describe('useMessageTemplates', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls.length = 0;
    templatesResponse = { templates: [] };
    // Object.assign supplies the `preconnect` static bun-types declares on
    // fetch, so the stub satisfies `typeof fetch` without a cast.
    const fetchStub: typeof fetch = Object.assign(mock(templatesFetch), { preconnect: () => {} });
    globalThis.fetch = fetchStub;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('renders with empty templates by default', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toEqual([]);
    });
  });

  it('returns templates from the API', async () => {
    templatesResponse = {
      templates: [{ id: '1', title: 'Test', content: 'content', sortOrder: 0, createdAt: '', updatedAt: '' }],
    };

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toHaveLength(1);
      expect(result.current.templates[0].title).toBe('Test');
    });
  });

  it('calls createMessageTemplate when addTemplate is called', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toBeDefined();
    });

    act(() => {
      result.current.addTemplate('New Title', 'New Content');
    });

    // Old: mockCreateMessageTemplate.toHaveBeenCalledWith('New Title', 'New Content').
    // New: the POST /api/message-templates carries the same title/content.
    await waitFor(() => {
      const posts = callsMatching(/\/api\/message-templates$/, 'POST');
      expect(posts).toHaveLength(1);
      expect(jsonBody(posts[0].body)).toEqual({ title: 'New Title', content: 'New Content' });
    });
  });

  it('calls updateMessageTemplate when updateTemplate is called', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toBeDefined();
    });

    act(() => {
      result.current.updateTemplate('1', { title: 'Updated Title' });
    });

    // Old: mockUpdateMessageTemplate.toHaveBeenCalledWith('1', { title: 'Updated Title' }).
    // New: the PUT targets /message-templates/1 with the same updates body.
    await waitFor(() => {
      const puts = callsMatching(/\/api\/message-templates\/1$/, 'PUT');
      expect(puts).toHaveLength(1);
      expect(jsonBody(puts[0].body)).toEqual({ title: 'Updated Title' });
    });
  });

  it('calls deleteMessageTemplate when deleteTemplate is called', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toBeDefined();
    });

    act(() => {
      result.current.deleteTemplate('1');
    });

    // Old: mockDeleteMessageTemplate.toHaveBeenCalledWith('1').
    // New: the DELETE targets /message-templates/1.
    await waitFor(() => {
      expect(callsMatching(/\/api\/message-templates\/1$/, 'DELETE')).toHaveLength(1);
    });
  });

  it('calls reorderMessageTemplates with correct ordered IDs', async () => {
    templatesResponse = {
      templates: [
        { id: 'a', title: 'A', content: 'Content A', sortOrder: 0, createdAt: '', updatedAt: '' },
        { id: 'b', title: 'B', content: 'Content B', sortOrder: 1, createdAt: '', updatedAt: '' },
        { id: 'c', title: 'C', content: 'Content C', sortOrder: 2, createdAt: '', updatedAt: '' },
      ],
    };

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toHaveLength(3);
    });

    // Move item at index 0 to index 2
    act(() => {
      result.current.reorderTemplates(0, 2);
    });

    // Old: mockReorderMessageTemplates.toHaveBeenCalledWith(['b', 'c', 'a']).
    // New: the PUT /message-templates/reorder carries the same ordered IDs.
    await waitFor(() => {
      const reorders = callsMatching(/\/api\/message-templates\/reorder$/, 'PUT');
      expect(reorders).toHaveLength(1);
      // After moving A from 0 to 2: [B, C, A]
      expect(jsonBody(reorders[0].body)).toEqual({ orderedIds: ['b', 'c', 'a'] });
    });
  });
});
