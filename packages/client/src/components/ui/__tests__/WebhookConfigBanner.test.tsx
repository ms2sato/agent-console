import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebhookConfigBanner } from '../WebhookConfigBanner';

// Save original fetch for restoration
const originalFetch = globalThis.fetch;

// Helper to create mock fetch response
function createMockFetchResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe('WebhookConfigBanner', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Clear localStorage for each test
    localStorage.clear();
    // Set up fetch-level mock
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    localStorage.clear();
    // Clean up rendered components
    cleanup();
  });

  afterAll(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  it('renders warning when webhook secret is not configured', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/system/health')) {
        return Promise.resolve(createMockFetchResponse({
          webhookSecretConfigured: false,
          appUrlConfigured: true,
        }));
      }
      return originalFetch(url);
    });

    renderWithProvider(<WebhookConfigBanner />);

    await waitFor(() => {
      expect(screen.getByText(/GitHub webhook secret not configured/i)).toBeDefined();
    });

    // Verify fetch was called with correct URL
    expect(mockFetch).toHaveBeenCalledWith('/api/system/health');
  });

  it('does not render when webhook secret is configured', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/system/health')) {
        return Promise.resolve(createMockFetchResponse({
          webhookSecretConfigured: true,
          appUrlConfigured: true,
        }));
      }
      return originalFetch(url);
    });

    renderWithProvider(<WebhookConfigBanner />);

    // Wait for query to resolve
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/system/health');
    });

    // Banner should not be visible
    expect(screen.queryByText(/GitHub webhook secret not configured/i)).toBeNull();
  });

  it('can be dismissed and persists dismissal state', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/system/health')) {
        return Promise.resolve(createMockFetchResponse({
          webhookSecretConfigured: false,
          appUrlConfigured: true,
        }));
      }
      return originalFetch(url);
    });

    renderWithProvider(<WebhookConfigBanner />);

    await waitFor(() => {
      expect(screen.getByText(/GitHub webhook secret not configured/i)).toBeDefined();
    });

    // Find and click the dismiss button
    const dismissButton = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissButton);

    // Banner should disappear
    expect(screen.queryByText(/GitHub webhook secret not configured/i)).toBeNull();

    // Dismissal should be persisted
    expect(localStorage.getItem('webhook-config-banner-dismissed')).toBe('true');
  });

  it('does not render when already dismissed', async () => {
    // Set dismissal state before rendering
    localStorage.setItem('webhook-config-banner-dismissed', 'true');

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/system/health')) {
        return Promise.resolve(createMockFetchResponse({
          webhookSecretConfigured: false,
          appUrlConfigured: true,
        }));
      }
      return originalFetch(url);
    });

    renderWithProvider(<WebhookConfigBanner />);

    // Wait for potential render
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/system/health');
    });

    // Banner should not appear even though webhook is not configured
    expect(screen.queryByText(/GitHub webhook secret not configured/i)).toBeNull();
  });

  it('contains a link to documentation', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/system/health')) {
        return Promise.resolve(createMockFetchResponse({
          webhookSecretConfigured: false,
          appUrlConfigured: true,
        }));
      }
      return originalFetch(url);
    });

    renderWithProvider(<WebhookConfigBanner />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /learn how to configure/i });
      expect(link).toBeDefined();
      expect(link.getAttribute('href')).toContain('inbound-integration');
    });
  });
});
