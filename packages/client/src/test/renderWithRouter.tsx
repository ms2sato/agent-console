import { render, act } from '@testing-library/react';
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';

export async function renderWithRouter(ui: React.ReactNode, initialPath = '/') {
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

  const result = render(<RouterProvider router={router} />);
  return { ...result, router };
}
