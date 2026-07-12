import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, cleanup, waitFor } from '@testing-library/react';
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

const mockFetch = mock(async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/embedded-agents')) {
    return jsonResponse(embeddedAgentsResponse);
  }
  if (url.includes('/agents')) {
    return jsonResponse(agentsResponse);
  }
  return jsonResponse({});
});

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
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

    await renderWithRouter(<AddAgentWorkerMenu onSelect={onSelect} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
      expect(screen.getByText('Ollama qwen3')).toBeTruthy();
    });
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByText('Embedded')).toBeTruthy();
  });

  it('empty embedded registry still shows terminal agents plus a create-link', async () => {
    agentsResponse = {
      agents: [{ id: 'claude-code', name: 'Claude Code', isBuiltIn: true }],
    };
    embeddedAgentsResponse = { embeddedAgents: [] };

    await renderWithRouter(<AddAgentWorkerMenu onSelect={async () => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeTruthy();
    });
    const manageLink = screen.getByText(/Manage agents/i).closest('a');
    expect(manageLink?.getAttribute('href')).toBe('/agents');
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

    await renderWithRouter(<AddAgentWorkerMenu onSelect={onSelect} />);
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

    await renderWithRouter(<AddAgentWorkerMenu onSelect={onSelect} />);
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
    await renderWithRouter(<AddAgentWorkerMenu onSelect={async () => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

    await waitFor(() => {
      expect(screen.getByText('No agents configured.')).toBeTruthy();
    });
  });
});
