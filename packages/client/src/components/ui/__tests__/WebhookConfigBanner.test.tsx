import { describe, expect, it, vi, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WebhookConfigBanner } from '../WebhookConfigBanner';
import * as api from '../../../lib/api';

// Mock the API module
vi.mock('../../../lib/api', () => ({
  fetchSystemHealth: vi.fn(),
}));

const mockFetchSystemHealth = api.fetchSystemHealth as ReturnType<typeof vi.fn>;

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
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementation to avoid cross-test contamination
    mockFetchSystemHealth.mockReset();
    // Clear localStorage for each test
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    // Clean up rendered components
    cleanup();
  });

  it('renders warning when webhook secret is not configured', async () => {
    mockFetchSystemHealth.mockResolvedValue({
      webhookSecretConfigured: false,
      appUrlConfigured: true,
    });

    renderWithProvider(<WebhookConfigBanner />);

    await waitFor(() => {
      expect(screen.getByText(/GitHub webhook secret not configured/i)).toBeDefined();
    });
  });

  it('does not render when webhook secret is configured', async () => {
    mockFetchSystemHealth.mockResolvedValue({
      webhookSecretConfigured: true,
      appUrlConfigured: true,
    });

    renderWithProvider(<WebhookConfigBanner />);

    // Wait for query to resolve
    await waitFor(() => {
      expect(mockFetchSystemHealth).toHaveBeenCalled();
    });

    // Banner should not be visible
    expect(screen.queryByText(/GitHub webhook secret not configured/i)).toBeNull();
  });

  it('can be dismissed and persists dismissal state', async () => {
    mockFetchSystemHealth.mockResolvedValue({
      webhookSecretConfigured: false,
      appUrlConfigured: true,
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

    mockFetchSystemHealth.mockResolvedValue({
      webhookSecretConfigured: false,
      appUrlConfigured: true,
    });

    renderWithProvider(<WebhookConfigBanner />);

    // Wait for potential render
    await waitFor(() => {
      expect(mockFetchSystemHealth).toHaveBeenCalled();
    });

    // Banner should not appear even though webhook is not configured
    expect(screen.queryByText(/GitHub webhook secret not configured/i)).toBeNull();
  });

  it('contains a link to documentation', async () => {
    mockFetchSystemHealth.mockResolvedValue({
      webhookSecretConfigured: false,
      appUrlConfigured: true,
    });

    renderWithProvider(<WebhookConfigBanner />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /learn how to configure/i });
      expect(link).toBeDefined();
      expect(link.getAttribute('href')).toContain('inbound-integration');
    });
  });
});
