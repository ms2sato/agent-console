import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditEmbeddedAgentForm } from '../EditEmbeddedAgentForm';
import type { EmbeddedAgentFormData } from '../EmbeddedAgentForm';

function renderEditEmbeddedAgentForm(props: React.ComponentProps<typeof EditEmbeddedAgentForm>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EditEmbeddedAgentForm {...props} />
    </QueryClientProvider>
  );
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
      name: 'Renamed Agent',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
      createdBy: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
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

const initialData: EmbeddedAgentFormData = {
  name: 'Existing Agent',
  description: 'Existing description',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:32b',
  apiKeyRef: 'existing-key',
  systemPrompt: '',
  maxToolIterationsInput: '',
};

describe('EditEmbeddedAgentForm', () => {
  it('PATCHes the entered data to /api/embedded-agents/:id and calls onSuccess', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData,
      onSuccess,
      onCancel: () => {},
    });

    const nameInput = screen.getByDisplayValue('Existing Agent');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Agent');

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    expect(getLastFetchUrl()).toContain('/api/embedded-agents/embedded-1');
    expect(getLastFetchMethod()).toBe('PATCH');
    const body = await getLastFetchBody();
    expect(body).toEqual({
      name: 'Renamed Agent',
      description: 'Existing description',
      provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b', apiKeyRef: 'existing-key' },
      systemPrompt: null,
      maxToolIterations: null,
    });
  });

  it('shows an error message and does not call onSuccess when the request fails', async () => {
    responseFactory = () =>
      jsonResponse({ error: 'Only the creator can update this embedded agent' }, 403);
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData,
      onSuccess,
      onCancel: () => {},
    });

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(screen.getByText('Only the creator can update this embedded agent')).toBeTruthy();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
