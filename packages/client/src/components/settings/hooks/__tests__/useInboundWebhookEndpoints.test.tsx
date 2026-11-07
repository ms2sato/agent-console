// NOTE: The fake server returns wire fields (secretSource, secret) in JSON that
// the api layer parses with the shared valibot schemas; the real server
// serializer is covered by packages/server route tests.
import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useInboundWebhookEndpointMutations, useInternetOrigin } from '../useInboundWebhookEndpoints';
import { inboundWebhookEndpointKeys } from '../../../../lib/query-keys';
import { installFakeServer, makeEndpoint } from '../../../../test/inbound-webhooks-fake-server';
import { findSecretHolders } from '../../../../test/assert-no-secret';

const server = installFakeServer();
afterAll(() => server.restore());

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  server.reset();
  server.endpoints = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(cleanup);

const ENTERED = `whsec_${Buffer.alloc(24, 4).toString('base64')}`;

describe('useInboundWebhookEndpointMutations', () => {
  it('create (generated) hands the secret to the callback, returns no secret and invalidates the repository list', async () => {
    const onSecret = mock((_s: unknown) => {});
    const invalidate = mock(queryClient.invalidateQueries.bind(queryClient));
    queryClient.invalidateQueries = invalidate as typeof queryClient.invalidateQueries;
    const { result } = renderHook(() => useInboundWebhookEndpointMutations('repo-1', onSecret), { wrapper });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.createEndpoint({ label: 'Alerts', instructionText: 'x' });
    });

    expect(onSecret).toHaveBeenCalledWith({ endpointId: 'ep-new', label: 'Alerts', secret: 'whsec_generated' });
    expect(JSON.stringify(returned)).not.toContain('whsec_generated');
    expect(returned).toMatchObject({ secretSource: 'generated' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: inboundWebhookEndpointKeys.all('repo-1') });
  });

  it('create (entered) reads the secret from takeSecret once, sends it, never calls the callback and returns no secret', async () => {
    const onSecret = mock((_s: unknown) => {});
    const take = mock(() => ENTERED as string | undefined);
    const { result } = renderHook(() => useInboundWebhookEndpointMutations('repo-1', onSecret), { wrapper });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.createEndpoint({ label: 'Alerts', instructionText: 'x', takeSecret: take });
    });

    expect(take).toHaveBeenCalledTimes(1);
    expect(server.calls.find((c) => c.method === 'POST')?.body).toEqual({ label: 'Alerts', instructionText: 'x', secret: ENTERED });
    expect(onSecret).not.toHaveBeenCalled();
    expect(returned).toMatchObject({ secretSource: 'entered' });
    expect(JSON.stringify(returned)).not.toContain(ENTERED);
    expect(findSecretHolders(queryClient, ENTERED)).toEqual([]);
  });

  it('rotate (generated) hands the new secret to the callback; (entered) sends the entered one and does not', async () => {
    server.endpoints = [makeEndpoint()];
    const onSecret = mock((_s: unknown) => {});
    const { result } = renderHook(() => useInboundWebhookEndpointMutations('repo-1', onSecret), { wrapper });

    await act(async () => {
      await result.current.rotateSecret({ endpoint: { id: 'ep-1', label: 'Slack alerts' } });
    });
    expect(onSecret).toHaveBeenCalledWith({ endpointId: 'ep-1', label: 'Slack alerts', secret: 'whsec_rotated' });

    onSecret.mockClear();
    await act(async () => {
      await result.current.rotateSecret({ endpoint: { id: 'ep-1', label: 'Slack alerts' }, takeSecret: () => ENTERED });
    });
    expect(server.calls.filter((c) => c.url.endsWith('/rotate-secret')).map((c) => c.body)).toEqual([{}, { secret: ENTERED }]);
    expect(onSecret).not.toHaveBeenCalled();
  });

  it('does not call the callback and rethrows when create fails; the mutation state is reset afterwards', async () => {
    server.failWith = 'nope';
    const onSecret = mock((_s: unknown) => {});
    const { result } = renderHook(() => useInboundWebhookEndpointMutations('repo-1', onSecret), { wrapper });

    await act(async () => {
      await expect(result.current.createEndpoint({ label: 'a', instructionText: 'x' })).rejects.toThrow('nope');
    });
    expect(onSecret).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.create.isIdle).toBe(true));
  });
});

describe('useInternetOrigin', () => {
  it('reports the origin from the health read, and null once loaded when unset', async () => {
    const { result } = renderHook(() => useInternetOrigin(), { wrapper });
    expect(result.current).toEqual({ internetOrigin: null, isLoaded: false });
    await waitFor(() => expect(result.current).toEqual({ internetOrigin: 'https://hooks.example.com', isLoaded: true }));

    cleanup();
    queryClient = new QueryClient();
    server.internetOrigin = null;
    const second = renderHook(() => useInternetOrigin(), { wrapper });
    await waitFor(() => expect(second.result.current).toEqual({ internetOrigin: null, isLoaded: true }));
  });
});
