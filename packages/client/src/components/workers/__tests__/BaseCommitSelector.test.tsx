import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BaseCommitSelector } from '../BaseCommitSelector';
import type { BranchesResponse } from '../../../lib/api';

// Mock fetch at the lowest level; fetchSessionBranches goes through the hono
// client which ultimately calls globalThis.fetch.
const originalFetch = globalThis.fetch;
const mockFetch = mock(
  (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(new Response())
);
// `typeof fetch` carries React DOM's `preconnect` augmentation; reuse the
// original implementation so the assigned stub satisfies the full type.
globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function createBranchesResponse(body: BranchesResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupBranchesMock(branches: BranchesResponse) {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = resolveUrl(input);
    if (url.includes('/branches')) {
      return Promise.resolve(createBranchesResponse(branches));
    }
    return Promise.resolve(new Response());
  });
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderSelector(
  props: Partial<React.ComponentProps<typeof BaseCommitSelector>> = {}
) {
  const onBaseCommitChange = props.onBaseCommitChange ?? mock(() => {});
  const result = render(
    <BaseCommitSelector
      sessionId="session-1"
      currentBaseCommit="abc1234def"
      onBaseCommitChange={onBaseCommitChange}
      {...props}
    />,
    { wrapper: TestWrapper }
  );
  return { ...result, onBaseCommitChange };
}

/** Open the dropdown by clicking the displayed base commit. */
async function openDropdown(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /abc1234/ }));
}

describe('BaseCommitSelector merge-base entries', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders both origin and local fork-point entries (origin first) when origin/<default> exists', async () => {
    setupBranchesMock({
      local: ['main', 'feature/x'],
      remote: ['origin/main', 'origin/feature/x'],
      defaultBranch: 'main',
    });
    const user = userEvent.setup();
    renderSelector();
    await openDropdown(user);

    const originEntry = await screen.findByText('Fork point from origin/main');
    const localEntry = await screen.findByText('Fork point from main (local)');
    expect(originEntry).toBeTruthy();
    expect(localEntry).toBeTruthy();

    // Origin variant must appear before the local variant in DOM order.
    const position = originEntry.compareDocumentPosition(localEntry);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders only the local fork-point entry when origin/<default> does NOT exist', async () => {
    setupBranchesMock({
      local: ['main', 'feature/x'],
      remote: ['origin/feature/x'], // no origin/main
      defaultBranch: 'main',
    });
    const user = userEvent.setup();
    renderSelector();
    await openDropdown(user);

    await screen.findByText('Fork point from main (local)');
    expect(screen.queryByText('Fork point from origin/main')).toBeNull();
  });

  it('calls onBaseCommitChange with merge-base:origin/<default> when clicking the origin variant', async () => {
    setupBranchesMock({
      local: ['main'],
      remote: ['origin/main'],
      defaultBranch: 'main',
    });
    const user = userEvent.setup();
    const { onBaseCommitChange } = renderSelector();
    await openDropdown(user);

    const originEntry = await screen.findByText('Fork point from origin/main');
    await user.click(originEntry);

    expect(onBaseCommitChange).toHaveBeenCalledWith('merge-base:origin/main');
  });

  it('calls onBaseCommitChange with merge-base:<default> when clicking the local variant', async () => {
    setupBranchesMock({
      local: ['main'],
      remote: ['origin/main'],
      defaultBranch: 'main',
    });
    const user = userEvent.setup();
    const { onBaseCommitChange } = renderSelector();
    await openDropdown(user);

    const localEntry = await screen.findByText('Fork point from main (local)');
    await user.click(localEntry);

    expect(onBaseCommitChange).toHaveBeenCalledWith('merge-base:main');
  });

  it('renders no merge-base entries when there is no default branch', async () => {
    setupBranchesMock({
      local: ['feature/x'],
      remote: ['origin/feature/x'],
      defaultBranch: null,
    });
    const user = userEvent.setup();
    renderSelector();
    await openDropdown(user);

    // Wait for the query to resolve so the dropdown reflects branchesData.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Fork point from/)).toBeNull();
  });
});
