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

  it('empty embedded registry still shows terminal agents plus a plain-text notice (no link)', async () => {
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
    // Architect ruling: no EmbeddedAgentDefinition CRUD UI exists yet, so this
    // must be plain text (not a link to a page that can't actually create one).
    const notice = screen.getByText((_content, element) =>
      element?.textContent ===
      'No embedded agents are registered yet. Definitions can currently be managed via the REST API (`/api/embedded-agents`); a management UI is coming in a follow-up.'
    );
    expect(notice).toBeTruthy();
    expect(notice.closest('a')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
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

    await renderWithRouter(<AddAgentWorkerMenu onSelect={async () => {}} />);
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
