import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { AddAgentWorkerMenu } from '../AddAgentWorkerMenu';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let agentsResponse: unknown = { agents: [] };
let embeddedAgentsResponse: unknown = { embeddedAgents: [] };

// bun-types declares `preconnect` as a static on `typeof fetch`; attach it
// directly instead of bypassing the type system with `as unknown as`.
const mockFetch = Object.assign(
  mock(async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/embedded-agents')) {
      return jsonResponse(embeddedAgentsResponse);
    }
    if (url.includes('/agents')) {
      return jsonResponse(agentsResponse);
    }
    return jsonResponse({});
  }),
  { preconnect: originalFetch.preconnect },
);

beforeEach(() => {
  globalThis.fetch = mockFetch;
  agentsResponse = { agents: [] };
  embeddedAgentsResponse = { embeddedAgents: [] };
  mockFetch.mockClear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('AddAgentWorkerMenu', () => {
  it('lists both kinds in one list, each with a kind badge', async () => {
    agentsResponse = {
      agents: [{ id: 'claude-code', name: 'Claude Code', isBuiltIn: true }],
    };
    embeddedAgentsResponse = {
      embeddedAgents: [
        {
          id: 'embedded-1',
          name: 'Ollama qwen3',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3' },
          createdBy: 'user-1',
          createdAt: '',
          updatedAt: '',
        },
      ],
    };
    const onSelect = mock(async () => {});

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={onSelect} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
      expect(screen.getByText('Ollama qwen3')).toBeTruthy();
    });
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByText('Embedded · Experimental')).toBeTruthy();
  });

  it('empty embedded registry still shows terminal agents plus a link to create one', async () => {
    agentsResponse = {
      agents: [{ id: 'claude-code', name: 'Claude Code', isBuiltIn: true }],
    };
    embeddedAgentsResponse = { embeddedAgents: [] };

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
    });
    // The management UI now exists at /agents (Phase 3.5), so the empty-state
    // notice links there instead of pointing to the REST API.
    expect(screen.getByText(/No embedded agents are registered yet/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Create one' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/agents');
  });

  it('clicking the empty-state "Create one" link closes the menu', async () => {
    embeddedAgentsResponse = { embeddedAgents: [] };

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    const link = await screen.findByRole('link', { name: 'Create one' });
    await user.click(link);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides the empty-embedded-registry notice once at least one embedded agent is registered', async () => {
    embeddedAgentsResponse = {
      embeddedAgents: [
        {
          id: 'embedded-1',
          name: 'Ollama qwen3',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3' },
          createdBy: 'user-1',
          createdAt: '',
          updatedAt: '',
        },
      ],
    };

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Ollama qwen3')).toBeTruthy();
    });
    expect(screen.queryByText(/No embedded agents are registered yet/)).toBeNull();
  });

  it('selecting an embedded-agent item calls onSelect with { type: "embedded-agent", embeddedAgentId }', async () => {
    embeddedAgentsResponse = {
      embeddedAgents: [
        {
          id: 'embedded-1',
          name: 'Ollama qwen3',
          provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3' },
          createdBy: 'user-1',
          createdAt: '',
          updatedAt: '',
        },
      ],
    };
    const onSelect = mock(async () => {});

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={onSelect} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Ollama qwen3')).toBeTruthy();
    });
    await user.click(screen.getByText('Ollama qwen3'));

    expect(onSelect).toHaveBeenCalledWith({ type: 'embedded-agent', embeddedAgentId: 'embedded-1' });
  });

  it('terminal agent items are disabled (adding an agent-backed worker to a running session is not REST-supported)', async () => {
    agentsResponse = {
      agents: [{ id: 'claude-code', name: 'Claude Code', isBuiltIn: true }],
    };
    const onSelect = mock(async () => {});

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={onSelect} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
    });
    const item = screen.getByText('Claude Code').closest('button');
    expect(item?.disabled).toBe(true);

    await user.click(item!);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows "No agents configured" when both registries are empty', async () => {
    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('No agents configured.')).toBeTruthy();
    });
  });

  it('fetches embedded agents from the /embedded-agents endpoint', async () => {
    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      const calledUrls = mockFetch.mock.calls.map(([input]) =>
        input instanceof Request ? input.url : String(input),
      );
      expect(calledUrls.some((url) => url.includes('/embedded-agents'))).toBe(true);
    });
  });

  it('shows a "Shell" item as the first item, with a distinct "Shell" badge, regardless of loading/empty state', async () => {
    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    const menu = screen.getByRole('menu');
    const menuItems = within(menu).getAllByRole('menuitem');
    expect(menuItems[0].textContent).toContain('Shell');

    const badges = within(menu).getAllByText('Shell');
    expect(badges.length).toBeGreaterThan(0);
  });

  it('shows the "Shell" item first even while agents/embedded-agents queries are loading', async () => {
    // Never-resolving fetch keeps the queries in the loading state indefinitely.
    globalThis.fetch = Object.assign(
      mock(() => new Promise<Response>(() => {})),
      { preconnect: originalFetch.preconnect },
    );

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Shell/ })).toBeTruthy();
    expect(within(menu).getByText('Loading...')).toBeTruthy();
  });

  it('clicking the "Shell" item closes the menu and calls onSelectShell', async () => {
    const onSelectShell = mock(async () => {});

    await renderWithRouter(
      <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={onSelectShell} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    const menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /Shell/ }));

    expect(onSelectShell).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
