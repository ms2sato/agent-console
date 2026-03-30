import { describe, it, expect, mock, afterEach, afterAll, beforeEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { RepositoryList } from '../RepositoryList';
import type { Repository } from '@agent-console/shared';

// Save original fetch and set up mock
const originalFetch = globalThis.fetch;
const mockFetch = mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function createMockResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function createTestRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'repo-1',
    name: 'test-repo',
    path: '/path/to/test-repo',
    createdAt: new Date().toISOString(),
    remoteUrl: 'https://github.com/test/test-repo.git',
    setupCommand: null,
    cleanupCommand: null,
    description: null,
    defaultAgentId: null,
    ...overrides,
  };
}

function setupMockFetch(repositories: Repository[]) {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/repositories')) {
      return Promise.resolve(createMockResponse({ repositories }));
    }
    return Promise.resolve(new Response('Not found', { status: 404 }));
  });
}

function setupMockFetchError() {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/repositories')) {
      return Promise.resolve(createMockResponse({ error: 'Network error' }, false));
    }
    return Promise.resolve(new Response('Not found', { status: 404 }));
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('RepositoryList', () => {
  describe('loading state', () => {
    it('shows loading spinner while fetching', async () => {
      // Make fetch hang to observe loading state
      mockFetch.mockImplementation(() => new Promise(() => {}));

      await renderWithRouter(<RepositoryList />);

      expect(screen.getByText('Loading repositories...')).toBeTruthy();
    });
  });

  describe('error state', () => {
    it('renders error message and retry button', async () => {
      setupMockFetchError();

      await renderWithRouter(<RepositoryList />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load repositories')).toBeTruthy();
      });

      const retryButton = screen.getByRole('button', { name: 'Retry' });
      expect(retryButton).toBeTruthy();

      // Set up a successful response for the retry
      setupMockFetch([createTestRepository()]);
      await userEvent.click(retryButton);

      await waitFor(() => {
        expect(screen.getByText('test-repo')).toBeTruthy();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty message when no repositories exist', async () => {
      setupMockFetch([]);

      await renderWithRouter(<RepositoryList />);

      await waitFor(() => {
        expect(screen.getByText('No repositories registered')).toBeTruthy();
      });
      expect(
        screen.getByText('Register repositories from the Dashboard to manage their setup commands.')
      ).toBeTruthy();
    });
  });

  describe('repository cards', () => {
    it('renders each repository as a link to its detail page', async () => {
      const repos = [
        createTestRepository({ id: 'repo-1', name: 'First Repo' }),
        createTestRepository({ id: 'repo-2', name: 'Second Repo' }),
      ];

      setupMockFetch(repos);

      await renderWithRouter(<RepositoryList />);

      await waitFor(() => {
        expect(screen.getByText('First Repo')).toBeTruthy();
      });

      const firstLink = screen.getByText('First Repo').closest('a');
      const secondLink = screen.getByText('Second Repo').closest('a');

      expect(firstLink?.getAttribute('href')).toBe('/settings/repositories/repo-1');
      expect(secondLink?.getAttribute('href')).toBe('/settings/repositories/repo-2');
    });

    it('displays repository name, path, and setup command summary', async () => {
      const repo = createTestRepository({
        name: 'My Project',
        path: '/home/user/my-project',
        setupCommand: 'bun install && bun run build',
      });

      setupMockFetch([repo]);

      await renderWithRouter(<RepositoryList />);

      await waitFor(() => {
        expect(screen.getByText('My Project')).toBeTruthy();
      });
      expect(screen.getByText('/home/user/my-project')).toBeTruthy();
      expect(screen.getByText('bun install && bun run build')).toBeTruthy();
    });

    it('shows "Not configured" when setupCommand is null', async () => {
      const repo = createTestRepository({ setupCommand: null });

      setupMockFetch([repo]);

      await renderWithRouter(<RepositoryList />);

      await waitFor(() => {
        expect(screen.getByText('Not configured')).toBeTruthy();
      });
    });

    it('shows "Not configured" when setupCommand is empty string', async () => {
      const repo = createTestRepository({ setupCommand: '' });

      setupMockFetch([repo]);

      await renderWithRouter(<RepositoryList />);

      await waitFor(() => {
        expect(screen.getByText('Not configured')).toBeTruthy();
      });
    });
  });
});
