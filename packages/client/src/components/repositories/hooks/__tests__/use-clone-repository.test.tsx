import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CloneJobStatusResponse } from '@agent-console/shared';
import {
  CLONE_JOB_POLL_INTERVAL_MS,
  useCloneJobStatus,
  useCloneRepository,
} from '../use-clone-repository';

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

function installScriptedFetch(opts: {
  postResponse?: { status: number; body: unknown };
  pollResponses: CloneJobStatusResponse[];
}) {
  let pollIdx = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const scripted = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (init?.method === 'POST') {
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

describe('useCloneRepository', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls POST /api/repositories/clone with the JSON body and returns jobId', async () => {
    const { calls } = installScriptedFetch({
      postResponse: { status: 202, body: { jobId: 'abc-123', repositoryId: null } },
      pollResponses: [],
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCloneRepository(), { wrapper: Wrapper });

    let returnedJobId: string | undefined;
    await act(async () => {
      const res = await result.current.mutateAsync({
        url: 'git@github.com:org/repo.git',
      });
      returnedJobId = res.jobId;
    });

    expect(returnedJobId).toBe('abc-123');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/repositories\/clone$/);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      url: 'git@github.com:org/repo.git',
    });
  });

  it('surfaces server errors with an ApiError-like message', async () => {
    installScriptedFetch({
      postResponse: { status: 400, body: { error: 'bad url', code: 'validation_error' } },
      pollResponses: [],
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCloneRepository(), { wrapper: Wrapper });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ url: 'https://example.com/foo.git' });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('bad url');
  });
});

describe('useCloneJobStatus', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('stays disabled (no fetch) when jobId is null', async () => {
    const { scripted } = installScriptedFetch({ pollResponses: [{ jobId: 'unused', status: 'cloning' }] });

    const { Wrapper } = createWrapper();
    renderHook(() => useCloneJobStatus(null), { wrapper: Wrapper });

    // Allow a microtask flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(scripted).not.toHaveBeenCalled();
  });

  it('polls until succeeded then stops', async () => {
    const { scripted } = installScriptedFetch({
      pollResponses: [
        { jobId: 'job-9', status: 'cloning' },
        { jobId: 'job-9', status: 'succeeded', repositoryId: 'repo-x' },
      ],
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCloneJobStatus('job-9'), { wrapper: Wrapper });

    await waitFor(
      () => {
        expect(result.current.data?.status).toBe('succeeded');
      },
      { timeout: 8000 }
    );

    const callsAtTerminal = scripted.mock.calls.length;
    // Wait longer than the poll interval to confirm no further polling.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CLONE_JOB_POLL_INTERVAL_MS + 500));
    });
    expect(scripted.mock.calls.length).toBe(callsAtTerminal);
  });

  it('stops polling on failed terminal status', async () => {
    const { scripted } = installScriptedFetch({
      pollResponses: [
        { jobId: 'job-fail', status: 'pending' },
        { jobId: 'job-fail', status: 'failed', error: { code: 'auth_failed', message: 'permission denied' } },
      ],
    });

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCloneJobStatus('job-fail'), { wrapper: Wrapper });

    await waitFor(
      () => {
        expect(result.current.data?.status).toBe('failed');
      },
      { timeout: 8000 }
    );

    const callsAtTerminal = scripted.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CLONE_JOB_POLL_INTERVAL_MS + 500));
    });
    expect(scripted.mock.calls.length).toBe(callsAtTerminal);
  });
});
