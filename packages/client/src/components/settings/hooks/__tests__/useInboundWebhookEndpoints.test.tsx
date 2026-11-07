// NOTE: The fake server returns wire fields (hasPreviousSecret, secret) in JSON
// that the api layer parses with the shared valibot schemas; the real server
// serializer is covered by packages/server route tests.
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useInboundWebhookEndpointMutations } from '../useInboundWebhookEndpoints';
import { inboundWebhookEndpointKeys } from '../../../../lib/query-keys';

const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const endpoint = {
  id: 'ep-1',
  label: 'Alerts',
  repositoryId: 'repo-1',
  instructionText: 'x',
  hasPreviousSecret: false,
  previousSecretExpiresAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockFetch.mockReset();
});
afterEach(cleanup);

describe('useInboundWebhookEndpointMutations', () => {
  it('create hands the secret to the callback, returns only the endpoint, and invalidates the list', async () => {
    mockFetch.mockImplementation(async () => json({ endpoint, secret: 'whsec_x' }, 201));
    const onSecret = mock((_s: unknown) => {});
    const invalidate = mock(queryClient.invalidateQueries.bind(queryClient));
    queryClient.invalidateQueries = invalidate as typeof queryClient.invalidateQueries;
    const { result } = renderHook(() => useInboundWebhookEndpointMutations(onSecret), { wrapper });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.create.mutateAsync({ label: 'Alerts', repositoryId: 'repo-1', instructionText: 'x' });
    });

    expect(onSecret).toHaveBeenCalledWith({ endpointId: 'ep-1', label: 'Alerts', secret: 'whsec_x' });
    expect(JSON.stringify(returned)).not.toContain('whsec_x');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboundWebhookEndpointKeys.all() });
  });

  it('rotate hands the new secret to the callback and strips it from the result', async () => {
    mockFetch.mockImplementation(async () => json({ endpoint, secret: 'whsec_new' }));
    const onSecret = mock((_s: unknown) => {});
    const { result } = renderHook(() => useInboundWebhookEndpointMutations(onSecret), { wrapper });

    await act(async () => {
      await result.current.rotate.mutateAsync('ep-1');
    });

    expect(onSecret).toHaveBeenCalledWith({ endpointId: 'ep-1', label: 'Alerts', secret: 'whsec_new' });
    await waitFor(() => expect(JSON.stringify(result.current.rotate.data ?? null)).not.toContain('whsec_new'));
  });

  it('does not call the callback when create fails', async () => {
    mockFetch.mockImplementation(async () => json({ error: 'nope' }, 400));
    const onSecret = mock((_s: unknown) => {});
    const { result } = renderHook(() => useInboundWebhookEndpointMutations(onSecret), { wrapper });

    await act(async () => {
      await expect(
        result.current.create.mutateAsync({ label: 'a', repositoryId: 'r', instructionText: 'x' }),
      ).rejects.toThrow('nope');
    });
    expect(onSecret).not.toHaveBeenCalled();
  });
});
