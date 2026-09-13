import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentParameterCapabilitiesByKind } from '@agent-console/shared';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { AddAgentWorkerMenu } from '../AddAgentWorkerMenu';
import type { AddAgentWorkerParams } from '../hooks/useTabManagement';
import { AGENT_KIND_PRESENTATION } from '../../agents';

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let agentsResponse: unknown = { agents: [] };
let embeddedAgentsResponse: unknown = { embeddedAgents: [] };

/** Terminal agent whose commandTemplate consumes {{model...}} but not {{effort...}}. */
const modelCapableAgent = {
  id: 'model-agent',
  name: 'Model Capable Agent',
  isBuiltIn: false,
  commandTemplate: 'mytool {{model:+--model}} {{prompt}}',
};

/** A second, independent model-only-capable terminal agent (distinct id/name). */
const modelCapableAgentTwo = {
  id: 'model-agent-2',
  name: 'Model Capable Agent Two',
  isBuiltIn: false,
  commandTemplate: 'mytool {{model:+--model}} {{prompt}}',
};

/** Terminal agent whose commandTemplate consumes neither placeholder. */
const incapableAgent = {
  id: 'plain-agent',
  name: 'Plain Agent',
  isBuiltIn: false,
  commandTemplate: 'mytool {{prompt}}',
};

/**
 * Embedded definition on the `claude-sdk` engine -- capable of both `model`
 * and `reasoningEffort` (and therefore `contextWindowTokens` once a model is
 * typed) in the real `EMBEDDED_AGENT_ENGINE_PARAMETER_CAPABILITIES` table.
 */
const embeddedClaudeSdkAgent = {
  id: 'embedded-claude-sdk-1',
  name: 'Local Claude SDK',
  engine: 'claude-sdk' as const,
};

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
          // engine is required on the real EmbeddedAgentDefinition wire shape
          // (agent-surface.md Ruling 1/2) -- AddAgentWorkerMenu now derives
          // per-item Options-toggle capability via
          // getAgentParameterCapabilitiesFor(entry), which reads
          // entry.agent.engine unconditionally for every embedded entry
          // (Issue #1560). Omitting it here would crash that derivation.
          engine: 'openai-api' as const,
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
    const terminalBadge = screen.getByText('Terminal');
    expect(terminalBadge).toBeTruthy();
    // Regression guard: fails if this badge ever reverts to inline classes
    // instead of reading from the single-writer AGENT_KIND_PRESENTATION
    // table (packages/client/src/components/agents/agentKindPresentation.ts).
    expect(terminalBadge.className).toContain(AGENT_KIND_PRESENTATION.terminal.badgeClassName);

    const embeddedBadge = screen.getByText('Embedded · Experimental');
    expect(embeddedBadge).toBeTruthy();
    expect(embeddedBadge.className).toContain(AGENT_KIND_PRESENTATION.embedded.badgeClassName);
  });

  it('preserves item order: Shell, then terminal entries, then embedded entries (useAgentDirectory merge order)', async () => {
    agentsResponse = {
      agents: [{ id: 'claude-code', name: 'Claude Code', isBuiltIn: true }],
    };
    embeddedAgentsResponse = {
      embeddedAgents: [
        {
          id: 'embedded-1',
          name: 'Ollama qwen3',
          // engine is required on the real EmbeddedAgentDefinition wire shape
          // (agent-surface.md Ruling 1/2) -- AddAgentWorkerMenu now derives
          // per-item Options-toggle capability via
          // getAgentParameterCapabilitiesFor(entry), which reads
          // entry.agent.engine unconditionally for every embedded entry
          // (Issue #1560). Omitting it here would crash that derivation.
          engine: 'openai-api' as const,
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

    const menu = screen.getByRole('menu');
    const menuItems = within(menu).getAllByRole('menuitem');
    const shellIndex = menuItems.findIndex((item) => item.textContent?.includes('Shell'));
    const terminalIndex = menuItems.findIndex((item) => item.textContent?.includes('Claude Code'));
    const embeddedIndex = menuItems.findIndex((item) => item.textContent?.includes('Ollama qwen3'));
    expect(shellIndex).toBe(0);
    expect(terminalIndex).toBeGreaterThan(shellIndex);
    expect(embeddedIndex).toBeGreaterThan(terminalIndex);
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
          // engine is required on the real EmbeddedAgentDefinition wire shape
          // (agent-surface.md Ruling 1/2) -- AddAgentWorkerMenu now derives
          // per-item Options-toggle capability via
          // getAgentParameterCapabilitiesFor(entry), which reads
          // entry.agent.engine unconditionally for every embedded entry
          // (Issue #1560). Omitting it here would crash that derivation.
          engine: 'openai-api' as const,
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
          // engine is required on the real EmbeddedAgentDefinition wire shape
          // (agent-surface.md Ruling 1/2) -- AddAgentWorkerMenu now derives
          // per-item Options-toggle capability via
          // getAgentParameterCapabilitiesFor(entry), which reads
          // entry.agent.engine unconditionally for every embedded entry
          // (Issue #1560). Omitting it here would crash that derivation.
          engine: 'openai-api' as const,
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

  it('selecting a terminal agent item calls onSelect with { type: "agent", agentId } (Issue #1023)', async () => {
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
    expect(item?.disabled).toBe(false);

    await user.click(item!);
    expect(onSelect).toHaveBeenCalledWith({ type: 'agent', agentId: 'claude-code' });
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

  // --- Issue #1560: per-item Options toggle exposing model/effort/window overrides ---

  describe('Options toggle (Issue #1560)', () => {
    it('shows an Options toggle only for entries whose capabilities have any true value', async () => {
      agentsResponse = { agents: [modelCapableAgent, incapableAgent] };
      embeddedAgentsResponse = { embeddedAgents: [embeddedClaudeSdkAgent] };

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      await waitFor(() => {
        expect(screen.getByText('Model Capable Agent')).toBeTruthy();
        expect(screen.getByText('Plain Agent')).toBeTruthy();
        expect(screen.getByText('Local Claude SDK')).toBeTruthy();
      });

      expect(screen.getByRole('button', { name: 'Options for Model Capable Agent' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Options for Plain Agent' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Options for Local Claude SDK' })).toBeTruthy();
      // Shell never gets a toggle -- it isn't an AgentKind at all.
      expect(screen.queryByRole('button', { name: /^Options for Shell/ })).toBeNull();
      // Exactly two toggles rendered (one per capable entry), never one for
      // the incapable terminal agent or for Shell.
      expect(screen.getAllByRole('button', { name: /^Options for/ })).toHaveLength(2);
    });

    it('expanding a terminal item renders Model but not Reasoning effort for a model-only-capable agent', async () => {
      agentsResponse = { agents: [modelCapableAgent] };

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      const toggle = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      await user.click(toggle);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.queryByPlaceholderText('e.g. high')).toBeNull();
    });

    it('expanding an embedded claude-sdk item renders Model and Reasoning effort; Context window appears only after a non-empty model is typed', async () => {
      embeddedAgentsResponse = { embeddedAgents: [embeddedClaudeSdkAgent] };

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      const toggle = await screen.findByRole('button', { name: 'Options for Local Claude SDK' });
      await user.click(toggle);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
      });
      expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
      expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();

      const modelInput = screen.getByPlaceholderText('e.g. opus');
      fireEvent.change(modelInput, { target: { value: 'claude-sonnet' } });

      await waitFor(() => {
        expect(screen.getByPlaceholderText('e.g. 128000')).toBeTruthy();
      });
    });

    it('Add with options calls onSelect with trimmed values and OMITS blank fields', async () => {
      embeddedAgentsResponse = { embeddedAgents: [embeddedClaudeSdkAgent] };
      const onSelect = mock((_params: AddAgentWorkerParams) => Promise.resolve());

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={onSelect} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      const toggle = await screen.findByRole('button', { name: 'Options for Local Claude SDK' });
      await user.click(toggle);

      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      // Leave Reasoning effort blank -- only the trimmed model must survive.
      fireEvent.change(modelInput, { target: { value: '  opus ' } });

      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      const callArg = onSelect.mock.calls[0][0];
      expect(callArg).toEqual({
        type: 'embedded-agent',
        embeddedAgentId: 'embedded-claude-sdk-1',
        model: 'opus',
      });
      // toEqual alone ignores undefined-valued keys, which is not the same
      // as key-absent -- this explicit property check is the actual pin.
      expect(callArg).not.toHaveProperty('reasoningEffort');
      expect(callArg).not.toHaveProperty('contextWindowTokens');
    });

    it('clearing the model clears a previously typed contextWindowTokens (embedded)', async () => {
      embeddedAgentsResponse = { embeddedAgents: [embeddedClaudeSdkAgent] };
      const onSelect = mock((_params: AddAgentWorkerParams) => Promise.resolve());

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={onSelect} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      const toggle = await screen.findByRole('button', { name: 'Options for Local Claude SDK' });
      await user.click(toggle);

      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      fireEvent.change(modelInput, { target: { value: 'opus' } });

      const windowInput = await waitFor(() => screen.getByPlaceholderText('e.g. 128000'));
      fireEvent.change(windowInput, { target: { value: '128000' } });

      fireEvent.change(modelInput, { target: { value: '' } });

      // The window input disappears once model is empty (AgentParameterFields
      // render-gating) -- but that alone doesn't prove the VALUE was
      // dropped, only that it's hidden. Retype a model and confirm the
      // window field comes back empty, proving the stored value -- not just
      // its rendering -- was cleared.
      await waitFor(() => {
        expect(screen.queryByPlaceholderText('e.g. 128000')).toBeNull();
      });
      fireEvent.change(modelInput, { target: { value: 'sonnet' } });
      const reappearedWindowInput = (await waitFor(() =>
        screen.getByPlaceholderText('e.g. 128000'),
      )) as HTMLInputElement;
      expect(reappearedWindowInput.value).toBe('');

      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(onSelect).toHaveBeenCalledTimes(1);
      const callArg = onSelect.mock.calls[0][0];
      expect(callArg).not.toHaveProperty('contextWindowTokens');
    });

    it('clicking the item name still adds immediately with no override keys', async () => {
      agentsResponse = { agents: [modelCapableAgent, modelCapableAgentTwo] };
      const onSelect = mock(async () => {});

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={onSelect} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      // Expand item A (Model Capable Agent) and type an override.
      const toggleA = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      await user.click(toggleA);
      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      fireEvent.change(modelInput, { target: { value: 'opus' } });

      // Click item B's (Model Capable Agent Two) NAME -- not its toggle,
      // which is a separate button and was never clicked. Item B also has
      // options capability (so this proves the fast path doesn't merely
      // work by accident on an incapable item), but its panel was never
      // opened.
      const itemBName = screen.getByText('Model Capable Agent Two').closest('button');
      await user.click(itemBName!);

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith({ type: 'agent', agentId: 'model-agent-2' });
    });

    it("expanding a second item clears the first item's typed values", async () => {
      agentsResponse = { agents: [modelCapableAgent, modelCapableAgentTwo] };

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      const toggleA = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      await user.click(toggleA);
      const modelInputA = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      fireEvent.change(modelInputA, { target: { value: 'opus' } });
      expect((modelInputA as HTMLInputElement).value).toBe('opus');

      const toggleB = screen.getByRole('button', { name: 'Options for Model Capable Agent Two' });
      await user.click(toggleB);

      // Item A collapsed, item B expanded and empty.
      const toggleAAfter = screen.getByRole('button', { name: 'Options for Model Capable Agent' });
      expect(toggleAAfter.getAttribute('aria-expanded')).toBe('false');
      const modelInputB = (await waitFor(() =>
        screen.getByPlaceholderText('e.g. opus'),
      )) as HTMLInputElement;
      expect(modelInputB.value).toBe('');

      // Re-expanding item A confirms its value did not survive either.
      await user.click(toggleAAfter);
      const modelInputAAgain = (await waitFor(() =>
        screen.getByPlaceholderText('e.g. opus'),
      )) as HTMLInputElement;
      expect(modelInputAAgain.value).toBe('');
    });

    it('closing the menu (outside click) resets the expanded panel', async () => {
      agentsResponse = { agents: [modelCapableAgent] };

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

      const toggle = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      await user.click(toggle);
      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      fireEvent.change(modelInput, { target: { value: 'opus' } });

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Add agent worker' }));
      const toggleAgain = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      expect(toggleAgain.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
    });

    it('closing the menu via the "+" trigger button also resets the expanded panel (CodeRabbit finding)', async () => {
      agentsResponse = { agents: [modelCapableAgent] };

      await renderWithRouter(
        <AddAgentWorkerMenu onSelect={async () => {}} onSelectShell={async () => {}} />,
      );
      const user = userEvent.setup();
      const trigger = screen.getByRole('button', { name: 'Add agent worker' });
      await user.click(trigger);

      const toggle = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      await user.click(toggle);
      const modelInput = await waitFor(() => screen.getByPlaceholderText('e.g. opus'));
      fireEvent.change(modelInput, { target: { value: 'opus' } });

      // Close the menu via the SAME "+" trigger button used to open it --
      // not an outside click. This is the exact toggle-closed branch a
      // stale reset would have missed.
      await user.click(trigger);
      expect(screen.queryByRole('menu')).toBeNull();

      await user.click(trigger);
      const toggleAgain = await screen.findByRole('button', { name: 'Options for Model Capable Agent' });
      expect(toggleAgain.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByPlaceholderText('e.g. opus')).toBeNull();
    });

    describe('getCapabilitiesImpl seam (single seam, both kinds -- proves the toggle gate and the fields cannot disagree)', () => {
      it('all-false hides the Options toggle for every agent item of both kinds', async () => {
        agentsResponse = { agents: [modelCapableAgent] };
        embeddedAgentsResponse = { embeddedAgents: [embeddedClaudeSdkAgent] };
        const disagreeAllFalse = (): AgentParameterCapabilitiesByKind => ({
          model: false,
          reasoningEffort: false,
          contextWindowTokens: false,
        });

        await renderWithRouter(
          <AddAgentWorkerMenu
            onSelect={async () => {}}
            onSelectShell={async () => {}}
            getCapabilitiesImpl={disagreeAllFalse}
          />,
        );
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

        await waitFor(() => {
          expect(screen.getByText('Model Capable Agent')).toBeTruthy();
          expect(screen.getByText('Local Claude SDK')).toBeTruthy();
        });

        expect(screen.queryByRole('button', { name: /^Options for/ })).toBeNull();
      });

      it('all-true shows the Options toggle on every agent item of both kinds, and the expanded fields follow the same seam', async () => {
        agentsResponse = { agents: [incapableAgent] };
        embeddedAgentsResponse = { embeddedAgents: [embeddedClaudeSdkAgent] };
        const alwaysCapable = (): AgentParameterCapabilitiesByKind => ({
          model: true,
          reasoningEffort: true,
          contextWindowTokens: true,
        });

        await renderWithRouter(
          <AddAgentWorkerMenu
            onSelect={async () => {}}
            onSelectShell={async () => {}}
            getCapabilitiesImpl={alwaysCapable}
          />,
        );
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Add agent worker' }));

        await waitFor(() => {
          expect(screen.getByText('Plain Agent')).toBeTruthy();
          expect(screen.getByText('Local Claude SDK')).toBeTruthy();
        });

        // Plain Agent's REAL commandTemplate is incapable of both -- if the
        // toggle gate re-derived capability itself instead of following the
        // injected seam, no toggle would render here at all.
        const toggle = screen.getByRole('button', { name: 'Options for Plain Agent' });
        expect(screen.getByRole('button', { name: 'Options for Local Claude SDK' })).toBeTruthy();

        await user.click(toggle);
        await waitFor(() => {
          expect(screen.getByPlaceholderText('e.g. opus')).toBeTruthy();
        });
        expect(screen.getByPlaceholderText('e.g. high')).toBeTruthy();
      });
    });
  });
});
