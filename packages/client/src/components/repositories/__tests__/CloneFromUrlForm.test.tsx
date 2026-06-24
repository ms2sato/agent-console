import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CloneJobStatusResponse } from '@agent-console/shared';
import { CloneFromUrlForm } from '../CloneFromUrlForm';
import { renderWithQuery } from '../../../test/renderWithQuery';

// The form uses raw `fetch` via `cloneRepository` / `fetchCloneJobStatus`.
// Each test installs its own scripted fetch.

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Install a fetch script that returns 202 for the clone POST and a
 * sequence of poll responses for the subsequent GETs. Each poll
 * advances to the next response in `pollResponses`; once exhausted, the
 * last response is repeated indefinitely.
 */
function installScriptedFetch(opts: {
  postResponse?: { status: number; body: unknown } | Error;
  pollResponses: CloneJobStatusResponse[];
}) {
  let pollIdx = 0;
  const calls: { url: string; init?: RequestInit }[] = [];

  const scripted = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });

    if (init?.method === 'POST') {
      if (opts.postResponse instanceof Error) {
        throw opts.postResponse;
      }
      const post = opts.postResponse ?? { status: 202, body: { jobId: 'job-1', repositoryId: null } };
      return new Response(JSON.stringify(post.body), {
        status: post.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const idx = Math.min(pollIdx, opts.pollResponses.length - 1);
    pollIdx += 1;
    return new Response(JSON.stringify(opts.pollResponses[idx]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  globalThis.fetch = scripted as unknown as typeof fetch;
  return { calls, scripted };
}

describe('CloneFromUrlForm', () => {
  describe('submit + success', () => {
    it('posts the clone request and resolves to onSuccess when polling reports succeeded', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      const { calls } = installScriptedFetch({
        pollResponses: [
          { jobId: 'job-1', status: 'cloning' },
          { jobId: 'job-1', status: 'succeeded', repositoryId: 'repo-42' },
        ],
      });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        'git@github.com:org/repo.git'
      );
      await user.click(screen.getByText('Clone & Register'));

      // Wait for onSuccess to fire with the repositoryId returned by the
      // terminal poll. This is intentionally lenient on intervals — we
      // care that it resolves at all.
      await waitFor(
        () => {
          expect(onSuccess).toHaveBeenCalled();
        },
        { timeout: 8000 }
      );
      const firstCall = onSuccess.mock.calls[0] as unknown as string[];
      expect(firstCall[0]).toBe('repo-42');

      // First call must be a POST to the clone endpoint with the URL.
      const postCall = calls.find((c) => c.init?.method === 'POST');
      expect(postCall).toBeTruthy();
      expect(postCall!.url).toMatch(/\/api\/repositories\/clone$/);
      const body = JSON.parse(postCall!.init!.body as string);
      expect(body).toMatchObject({ url: 'git@github.com:org/repo.git' });
    });
  });

  describe('submit + failure', () => {
    it('renders the human-readable error for a classified failure', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      installScriptedFetch({
        pollResponses: [
          {
            jobId: 'job-1',
            status: 'failed',
            error: { code: 'repo_not_found', message: 'fatal: repository not found' },
          },
        ],
      });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        'https://example.invalid/foo.git'
      );
      await user.click(screen.getByText('Clone & Register'));

      await waitFor(() => {
        expect(screen.getByText(/Repository not found at the given URL\./)).toBeTruthy();
      }, { timeout: 8000 });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('renders the raw error message verbatim for the unknown code', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      installScriptedFetch({
        pollResponses: [
          {
            jobId: 'job-1',
            status: 'failed',
            error: { code: 'unknown', message: 'something obscure happened: rc=137' },
          },
        ],
      });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        'https://example.com/foo.git'
      );
      await user.click(screen.getByText('Clone & Register'));

      await waitFor(() => {
        expect(screen.getByText(/something obscure happened: rc=137/)).toBeTruthy();
      }, { timeout: 8000 });
    });

    it('displays a submit error when the POST itself fails', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      installScriptedFetch({
        postResponse: {
          status: 409,
          body: { error: 'Name already in use', code: 'name_conflict' },
        },
        pollResponses: [],
      });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        'https://example.com/foo.git'
      );
      await user.click(screen.getByText('Clone & Register'));

      await waitFor(() => {
        expect(screen.getByText(/Name already in use/)).toBeTruthy();
      });
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('blocks submission when URL is empty', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      // The form should not POST at all, so fetch must remain unused.
      const installed = installScriptedFetch({ pollResponses: [] });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.click(screen.getByText('Clone & Register'));

      await waitFor(() => {
        expect(screen.getByText(/URL is required/)).toBeTruthy();
      });
      expect(installed.scripted).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('blocks submission when URL is shaped wrongly', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      const installed = installScriptedFetch({ pollResponses: [] });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        '--upload-pack=evil'
      );
      await user.click(screen.getByText('Clone & Register'));

      await waitFor(() => {
        expect(screen.getByText(/URL must be https:\/\//)).toBeTruthy();
      });
      expect(installed.scripted).not.toHaveBeenCalled();
    });

    it('blocks submission when optional name has invalid characters', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      const installed = installScriptedFetch({ pollResponses: [] });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        'git@github.com:org/repo.git'
      );
      await user.type(
        screen.getByPlaceholderText(/URL's last segment/),
        '../etc'
      );
      await user.click(screen.getByText('Clone & Register'));

      await waitFor(() => {
        expect(
          screen.getByText(
            /Name must contain only \[A-Za-z0-9\._-\]/
          )
        ).toBeTruthy();
      });
      expect(installed.scripted).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('calls onCancel when the cancel button is clicked', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.click(screen.getByText('Cancel'));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('polling lifecycle', () => {
    it('stops polling after the failed terminal state is observed', async () => {
      const onSuccess = mock(() => {});
      const onCancel = mock(() => {});

      const { scripted } = installScriptedFetch({
        pollResponses: [
          { jobId: 'job-1', status: 'failed', error: { code: 'timeout', message: 'timed out after 600s' } },
        ],
      });

      const user = userEvent.setup();
      await renderWithQuery(<CloneFromUrlForm onSuccess={onSuccess} onCancel={onCancel} />);

      await user.type(
        screen.getByPlaceholderText(/https:\/\/github\.com/),
        'https://example.com/foo.git'
      );
      await user.click(screen.getByText('Clone & Register'));

      // Wait for the failed-state text to appear.
      await waitFor(() => {
        expect(screen.getByText(/Clone took too long/)).toBeTruthy();
      }, { timeout: 8000 });

      // Count fetch calls right after observing failure, then wait long
      // enough that any further polling tick would have fired.
      const callsAtFailure = scripted.mock.calls.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      });
      expect(scripted.mock.calls.length).toBe(callsAtFailure);
    });
  });
});
