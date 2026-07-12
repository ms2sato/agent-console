/**
 * Tests for the Agents umbrella page (routes/agents/index.tsx), focused on
 * the `EmbeddedAgentsSection` area -- see Issue #1029 PR #1031 architect
 * audit. This area had zero rendering tests: the single-user Edit/Delete
 * gating bug (fixed in 75b87ec) and the delete-cache-invalidation MAJOR fix
 * (CodeRabbit round) both shipped from here because `canManageEmbeddedAgent`
 * unit tests alone cannot catch a WIRING bug between the helper and the JSX
 * -- only a test that renders the section and asserts on actual button
 * visibility / actual refetch behavior can.
 *
 * `useAppWsState` is replaced via `spyOn` (not `mock.module`, which is
 * process-global in bun:test) to force `agentsSynced: true` so
 * `TerminalAgentsSection` doesn't get stuck in its loading state -- mirrors
 * `routes/__tests__/index.test.tsx`'s DashboardPage test pattern. `useAuth`
 * is driven through its real public setters (`setAuthMode`/`setCurrentUser`)
 * rather than mocked, since it is a real external store with a public API
 * (see `lib/auth.ts`). `SessionDataContext` is provided directly via React
 * context (no mocking needed -- it's plain prop injection). `fetch` is
 * mocked at the network boundary.
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EmbeddedAgentDefinition, Session } from '@agent-console/shared';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { AgentsPage } from '../../../routes/agents/index';
import { SessionDataContext } from '../../../contexts/root-contexts';
import { setAuthMode, setCurrentUser, _reset as resetAuth } from '../../../lib/auth';
import * as useAppWsModule from '../../../hooks/useAppWs';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeEmbeddedAgent(overrides: Partial<EmbeddedAgentDefinition> = {}): EmbeddedAgentDefinition {
  return {
    id: 'embedded-1',
    name: 'Ollama qwen3',
    provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
    createdBy: 'creator-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let agentsResponse: unknown = { agents: [] };
let embeddedAgentsResponse: unknown = { embeddedAgents: [] };
let embeddedAgentsGetCount = 0;
let deleteEmbeddedAgentCalls: string[] = [];

const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (url.includes('/api/embedded-agents')) {
    if (method === 'DELETE') {
      const id = url.split('/').pop() ?? '';
      deleteEmbeddedAgentCalls.push(id);
      return jsonResponse({ success: true });
    }
    embeddedAgentsGetCount += 1;
    return jsonResponse(embeddedAgentsResponse);
  }
  if (url.includes('/api/agents')) {
    return jsonResponse(agentsResponse);
  }
  return jsonResponse({});
});

let useAppWsStateSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockClear();
  agentsResponse = { agents: [] };
  embeddedAgentsResponse = { embeddedAgents: [] };
  embeddedAgentsGetCount = 0;
  deleteEmbeddedAgentCalls = [];
  resetAuth();
  useAppWsStateSpy = spyOn(useAppWsModule, 'useAppWsState').mockImplementation(<T,>() => true as T);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useAppWsStateSpy.mockRestore();
  resetAuth();
});

function renderAgentsPage(sessions: Session[] = []) {
  return renderWithRouter(
    <SessionDataContext.Provider value={{ sessions, wsInitialized: true, workerActivityStates: {} }}>
      <AgentsPage />
    </SessionDataContext.Provider>
  );
}

describe('AgentsPage / EmbeddedAgentsSection', () => {
  it('(a) renders both terminal and embedded agents in the same umbrella', async () => {
    agentsResponse = {
      agents: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          isBuiltIn: true,
          commandTemplate: 'claude {{prompt}}',
          capabilities: {
            supportsContinue: false,
            supportsHeadlessMode: false,
            supportsActivityDetection: false,
          },
        },
      ],
    };
    embeddedAgentsResponse = { embeddedAgents: [makeEmbeddedAgent()] };

    await renderAgentsPage();

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
      expect(screen.getByText('Ollama qwen3')).toBeTruthy();
    });
    expect(screen.getByText('Terminal Agents')).toBeTruthy();
    expect(screen.getByText('Embedded Agents')).toBeTruthy();
  });

  it('(b) hides Edit/Delete when the viewer cannot manage the definition (multi-user, non-matching creator)', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'viewer-1', username: 'viewer', homeDir: '/home/viewer' });
    embeddedAgentsResponse = { embeddedAgents: [makeEmbeddedAgent({ createdBy: 'someone-else' })] };

    await renderAgentsPage();

    await waitFor(() => {
      expect(screen.getByText('Ollama qwen3')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('(c) shows Edit/Delete when the viewer can manage the definition (multi-user, matching creator)', async () => {
    setAuthMode('multi-user');
    setCurrentUser({ id: 'creator-1', username: 'creator', homeDir: '/home/creator' });
    embeddedAgentsResponse = { embeddedAgents: [makeEmbeddedAgent({ createdBy: 'creator-1' })] };

    await renderAgentsPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('(c-single-user) shows Edit/Delete in single-user mode regardless of createdBy (the 75b87ec regression guard)', async () => {
    // authMode defaults to 'none' (single-user) after resetAuth(); currentUser stays null,
    // exactly the state that exposed the original bug.
    embeddedAgentsResponse = { embeddedAgents: [makeEmbeddedAgent({ createdBy: 'someone-else' })] };

    await renderAgentsPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('(d) refetches the embedded-agents list after a successful delete instead of relying solely on the WS broadcast', async () => {
    const user = userEvent.setup();
    embeddedAgentsResponse = { embeddedAgents: [makeEmbeddedAgent()] };

    await renderAgentsPage(); // single-user default -> canManage true

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    });
    const getCountBeforeDelete = embeddedAgentsGetCount;
    expect(getCountBeforeDelete).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteEmbeddedAgentCalls).toEqual(['embedded-1']);
    });
    // The onSuccess handler calls queryClient.invalidateQueries(), which
    // (with the default staleTime of 0 used by renderWithRouter's
    // QueryClient) triggers an immediate refetch for the still-mounted
    // query -- observable as an additional GET beyond the initial mount.
    await waitFor(() => {
      expect(embeddedAgentsGetCount).toBeGreaterThan(getCountBeforeDelete);
    });
  });
});
