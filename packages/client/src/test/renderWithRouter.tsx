import { render, act } from '@testing-library/react';
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export async function renderWithRouter(ui: React.ReactNode, initialPath = '/') {
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

  const rootRoute = createRootRoute({
    component: () => <>{ui}</>,
  });
  const memoryHistory = createMemoryHistory({
    initialEntries: [initialPath],
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: memoryHistory,
    defaultPendingMinMs: 0,
  });

  // Wait for router to be ready
  await act(async () => {
    await router.load();
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...result, router, queryClient };
}
