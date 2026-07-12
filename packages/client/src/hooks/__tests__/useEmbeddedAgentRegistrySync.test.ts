import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useEmbeddedAgentRegistrySync } from '../useEmbeddedAgentRegistrySync';
import { embeddedAgentKeys } from '../../lib/query-keys';
import { _reset as resetWebSocket } from '../../lib/app-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';

const mockEmbeddedAgent = {
  id: 'embedded-agent-1',
  name: 'Local GPT',
  provider: { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' },
  createdBy: 'alice',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

describe('useEmbeddedAgentRegistrySync', () => {
  let restoreWebSocket: () => void;
  let queryClient: QueryClient;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    });
    resetWebSocket();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
  });

  afterEach(() => {
    restoreWebSocket();
    queryClient.clear();
    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation);
    }
  });

  function renderWithQueryClient() {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(() => useEmbeddedAgentRegistrySync(), { wrapper });
  }

  it('invalidates embeddedAgentKeys.all() when embedded-agent-created arrives', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'embedded-agent-created', embeddedAgent: mockEmbeddedAgent }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: embeddedAgentKeys.all() });
  });

  it('invalidates embeddedAgentKeys.all() when embedded-agent-updated arrives', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'embedded-agent-updated', embeddedAgent: mockEmbeddedAgent }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: embeddedAgentKeys.all() });
  });

  it('invalidates embeddedAgentKeys.all() when embedded-agent-deleted arrives', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({ type: 'embedded-agent-deleted', embeddedAgentId: 'embedded-agent-1' }),
      );
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: embeddedAgentKeys.all() });
  });

  it('does not invalidate on unrelated frames (e.g. agent-created)', () => {
    const invalidateSpy = spyOn(queryClient, 'invalidateQueries');
    renderWithQueryClient();

    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
      ws?.simulateMessage(
        JSON.stringify({
          type: 'agent-created',
          agent: {
            id: 'agent-1',
            name: 'Claude Code',
            commandTemplate: 'claude {{prompt}}',
            isBuiltIn: false,
            createdAt: '2024-01-01',
            capabilities: { supportsContinue: false, supportsHeadlessMode: false, supportsActivityDetection: false },
          },
        }),
      );
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
