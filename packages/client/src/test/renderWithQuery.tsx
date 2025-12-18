import { render, act, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Render a component wrapped with QueryClientProvider for testing components
 * that use React Query hooks.
 */
export async function renderWithQuery(
  ui: React.ReactNode,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });

  // Wrapper component
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...options });

  // Wait for initial render
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { ...result, queryClient };
}
