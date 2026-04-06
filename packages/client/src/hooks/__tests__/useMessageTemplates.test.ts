import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { MessageTemplate } from '@agent-console/shared';

const mockFetchMessageTemplates = mock(() => Promise.resolve({ templates: [] as MessageTemplate[] }));
const mockCreateMessageTemplate = mock((_title: string, _content: string) =>
  Promise.resolve({
    template: { id: '1', title: 'Test', content: 'content', sortOrder: 0, createdAt: '', updatedAt: '' },
  }),
);
const mockUpdateMessageTemplate = mock((_id: string, _updates: { title?: string; content?: string }) =>
  Promise.resolve({
    template: { id: '1', title: 'Updated', content: 'content', sortOrder: 0, createdAt: '', updatedAt: '' },
  }),
);
const mockDeleteMessageTemplate = mock((_id: string) => Promise.resolve({ success: true }));
const mockReorderMessageTemplates = mock((_orderedIds: string[]) => Promise.resolve({ success: true }));

mock.module('../../lib/api', () => ({
  fetchMessageTemplates: mockFetchMessageTemplates,
  createMessageTemplate: mockCreateMessageTemplate,
  updateMessageTemplate: mockUpdateMessageTemplate,
  deleteMessageTemplate: mockDeleteMessageTemplate,
  reorderMessageTemplates: mockReorderMessageTemplates,
}));

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
  beforeEach(() => {
    mockFetchMessageTemplates.mockClear();
    mockCreateMessageTemplate.mockClear();
    mockUpdateMessageTemplate.mockClear();
    mockDeleteMessageTemplate.mockClear();
    mockReorderMessageTemplates.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with empty templates by default', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toEqual([]);
    });
  });

  it('returns templates from the API', async () => {
    const templates: MessageTemplate[] = [
      { id: '1', title: 'Test', content: 'content', sortOrder: 0, createdAt: '', updatedAt: '' },
    ];
    mockFetchMessageTemplates.mockImplementation(() => Promise.resolve({ templates }));

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

    await waitFor(() => {
      expect(mockCreateMessageTemplate).toHaveBeenCalledWith('New Title', 'New Content');
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

    await waitFor(() => {
      expect(mockUpdateMessageTemplate).toHaveBeenCalledWith('1', { title: 'Updated Title' });
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

    await waitFor(() => {
      expect(mockDeleteMessageTemplate).toHaveBeenCalledWith('1');
    });
  });

  it('calls reorderMessageTemplates with correct ordered IDs', async () => {
    const templates: MessageTemplate[] = [
      { id: 'a', title: 'A', content: 'Content A', sortOrder: 0, createdAt: '', updatedAt: '' },
      { id: 'b', title: 'B', content: 'Content B', sortOrder: 1, createdAt: '', updatedAt: '' },
      { id: 'c', title: 'C', content: 'Content C', sortOrder: 2, createdAt: '', updatedAt: '' },
    ];
    mockFetchMessageTemplates.mockImplementation(() => Promise.resolve({ templates }));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMessageTemplates(), { wrapper });

    await waitFor(() => {
      expect(result.current.templates).toHaveLength(3);
    });

    // Move item at index 0 to index 2
    act(() => {
      result.current.reorderTemplates(0, 2);
    });

    await waitFor(() => {
      // After moving A from 0 to 2: [B, C, A]
      expect(mockReorderMessageTemplates).toHaveBeenCalledWith(['b', 'c', 'a']);
    });
  });
});
