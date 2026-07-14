import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { embeddedAgentKeys } from '../../../lib/query-keys';
import { AddEmbeddedAgentForm } from '../AddEmbeddedAgentForm';

function renderAddEmbeddedAgentForm(props: React.ComponentProps<typeof AddEmbeddedAgentForm>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AddEmbeddedAgentForm {...props} />
    </QueryClientProvider>
  );
  return { ...result, queryClient };
}

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const successResponse = () =>
  jsonResponse({
    embeddedAgent: {
      id: 'embedded-1',
      name: 'Ollama qwen3',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      createdBy: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });

let responseFactory: () => Response = successResponse;

const mockFetch = Object.assign(
  mock(async (_input: RequestInfo | URL, _init?: RequestInit) => responseFactory()),
  { preconnect: originalFetch.preconnect },
);

beforeEach(() => {
  globalThis.fetch = mockFetch;
  mockFetch.mockClear();
  responseFactory = successResponse;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// Helper to get the URL from the fetch call (Hono RPC client may pass URL or Request object)
function getLastFetchUrl(): string {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg = calls[calls.length - 1]?.[0];
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.toString();
  if (arg instanceof Request) return arg.url;
  return String(arg);
}

function getLastFetchMethod(): string {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg0 = calls[calls.length - 1]?.[0];
  const arg1 = calls[calls.length - 1]?.[1] as { method?: string } | undefined;
  if (arg0 instanceof Request) return arg0.method;
  return arg1?.method || 'GET';
}

async function getLastFetchBody(): Promise<unknown> {
  const calls = mockFetch.mock.calls as unknown[][];
  const arg0 = calls[calls.length - 1]?.[0];
  const arg1 = calls[calls.length - 1]?.[1] as { body?: string } | undefined;
  if (arg0 instanceof Request) {
    const text = await arg0.text();
    return text ? JSON.parse(text) : undefined;
  }
  return arg1?.body ? JSON.parse(arg1.body) : undefined;
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'Ollama qwen3');
  await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
}

describe('AddEmbeddedAgentForm', () => {
  it('POSTs the entered data to /api/embedded-agents and calls onSuccess', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderAddEmbeddedAgentForm({ onSuccess, onCancel: () => {} });

    await fillRequiredFields(user);
    await user.click(screen.getByText('Add Embedded Agent'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect(getLastFetchUrl()).toContain('/api/embedded-agents');
    expect(getLastFetchMethod()).toBe('POST');
    const body = await getLastFetchBody();
    expect(body).toEqual({
      name: 'Ollama qwen3',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      enabledTools: ['Read', 'Glob', 'Grep'],
    });
  });

  it('includes instructions in the POST body when file paths are added', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderAddEmbeddedAgentForm({ onSuccess, onCancel: () => {} });

    await fillRequiredFields(user);
    await user.click(screen.getByText('+ Add file'));
    await user.type(screen.getByPlaceholderText('e.g., docs/AGENTS.md'), 'docs/AGENTS.md');
    await user.click(screen.getByText('Add Embedded Agent'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const body = await getLastFetchBody();
    expect(body).toMatchObject({ instructions: ['docs/AGENTS.md'] });
  });

  it('invalidates the embedded-agents query on success (does not rely solely on the WS broadcast)', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    const { queryClient } = renderAddEmbeddedAgentForm({ onSuccess, onCancel: () => {} });
    const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
    queryClient.invalidateQueries = invalidateSpy;

    await fillRequiredFields(user);
    await user.click(screen.getByText('Add Embedded Agent'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: embeddedAgentKeys.all() });
  });

  it('shows an error message and does not call onSuccess when the request fails', async () => {
    responseFactory = () => jsonResponse({ error: 'Invalid provider' }, 400);
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderAddEmbeddedAgentForm({ onSuccess, onCancel: () => {} });

    await fillRequiredFields(user);
    await user.click(screen.getByText('Add Embedded Agent'));

    await waitFor(() => {
      expect(screen.getByText('Invalid provider')).toBeTruthy();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
