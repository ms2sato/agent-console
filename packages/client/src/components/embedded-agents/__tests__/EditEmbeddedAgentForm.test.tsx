import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { embeddedAgentKeys } from '../../../lib/query-keys';
import { EditEmbeddedAgentForm } from '../EditEmbeddedAgentForm';
import type { EmbeddedAgentFormData } from '../EmbeddedAgentForm';

function renderEditEmbeddedAgentForm(props: React.ComponentProps<typeof EditEmbeddedAgentForm>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <EditEmbeddedAgentForm {...props} />
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
  enabledTools: ['Read', 'Glob', 'Grep'],
  instructions: [],
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
      enabledTools: ['Read', 'Glob', 'Grep'],
      instructions: null,
      contextWindowTokens: null,
      handoff: null,
    });
  });

  it('PATCHes contextWindowTokens and a handoff object when both threshold inputs are set', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData: {
        ...initialData,
        contextWindowTokensInput: '128000',
        handoffSoftRatioInput: '75',
        handoffHardRatioInput: '90',
      },
      onSuccess,
      onCancel: () => {},
    });

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const body = await getLastFetchBody();
    expect(body).toMatchObject({
      contextWindowTokens: 128000,
      handoff: { softRatio: 0.75, hardRatio: 0.9 },
    });
  });

  it('PATCHes handoff: null when both threshold inputs are cleared', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData: {
        ...initialData,
        contextWindowTokensInput: '128000',
        handoffSoftRatioInput: '75',
        handoffHardRatioInput: '90',
      },
      onSuccess,
      onCancel: () => {},
    });

    await user.clear(screen.getByDisplayValue('75'));
    await user.clear(screen.getByDisplayValue('90'));

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const body = await getLastFetchBody();
    expect(body).toMatchObject({ handoff: null });
  });

  it('sends the current checkbox state as an explicit enabledTools array, not a hardcoded default', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData,
      onSuccess,
      onCancel: () => {},
    });

    await user.click(screen.getByRole('checkbox', { name: 'Bash' }));
    await user.click(screen.getByRole('checkbox', { name: 'Grep' }));

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const body = (await getLastFetchBody()) as { enabledTools: string[] };
    expect([...body.enabledTools].sort()).toEqual(['Bash', 'Glob', 'Read']);
  });

  it('sends the added instruction file paths in the PATCH body', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData,
      onSuccess,
      onCancel: () => {},
    });

    await user.click(screen.getByText('+ Add file'));
    await user.type(screen.getByPlaceholderText('e.g., docs/AGENTS.md'), 'docs/new-note.md');

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const body = await getLastFetchBody();
    expect(body).toMatchObject({ instructions: ['docs/new-note.md'] });
  });

  it('sends instructions: null when all instruction entries are removed', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData: { ...initialData, instructions: [{ path: 'existing/note.md' }] },
      onSuccess,
      onCancel: () => {},
    });

    await user.click(screen.getByText('Remove'));

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const body = await getLastFetchBody();
    expect(body).toMatchObject({ instructions: null });
  });

  it('invalidates the embedded-agents query on success (does not rely solely on the WS broadcast)', async () => {
    const user = userEvent.setup();
    const onSuccess = mock(() => {});
    const { queryClient } = renderEditEmbeddedAgentForm({
      embeddedAgentId: 'embedded-1',
      initialData,
      onSuccess,
      onCancel: () => {},
    });
    const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
    queryClient.invalidateQueries = invalidateSpy;

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: embeddedAgentKeys.all() });
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
