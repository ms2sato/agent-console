/**
 * Client-Server Boundary Test: AgentForm
 *
 * Tests that the client sends correct data AND the server accepts it correctly.
 * This catches boundary mismatches like `null` vs `undefined` that unit tests miss.
 *
 * Key scenario: Clearing askingPatterns field should send `null` (not undefined)
 * so the server clears the activityPatterns field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Hono } from 'hono';

// Import test utilities from server package
import {
  createTestApp,
  setupTestEnvironment,
  cleanupTestEnvironment,
} from '@agent-console/server/src/__tests__/test-utils';

// Import client components and test utilities
import { AddAgentForm, EditAgentForm } from '@agent-console/client/src/components/agents';
import { renderWithQuery } from '@agent-console/client/src/test/renderWithQuery';

// Import integration test utilities
import { createFetchBridge, findRequest } from './test-utils';

describe('Client-Server Boundary: EditAgentForm', () => {
  let app: Hono;
  let bridge: ReturnType<typeof createFetchBridge>;

  beforeEach(async () => {
    setupTestEnvironment();
    app = await createTestApp();
    bridge = createFetchBridge(app);
  });

  afterEach(() => {
    cleanup();
    bridge.restore();
    cleanupTestEnvironment();
  });

  it('should send null to clear activityPatterns when askingPatterns field is cleared', async () => {
    const user = userEvent.setup();

    // 1. Create agent with activityPatterns via server directly
    const createRes = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Agent',
        commandTemplate: 'test-cmd {{prompt}}',
        activityPatterns: { askingPatterns: ['pattern1', 'pattern2'] },
      }),
    });
    expect(createRes.status).toBe(201);
    const { agent: created } = await createRes.json();
    expect(created.activityPatterns?.askingPatterns).toEqual(['pattern1', 'pattern2']);

    // 2. Render EditAgentForm (the actual production component)
    await renderWithQuery(
      <EditAgentForm
        agentId={created.id}
        initialData={{
          name: created.name,
          commandTemplate: created.commandTemplate,
          continueTemplate: '',
          headlessTemplate: '',
          description: '',
          askingPatternsInput: 'pattern1\npattern2', // Start with existing patterns
        }}
        onSuccess={() => {}}
        onCancel={() => {}}
      />
    );

    // 3. Advanced Settings should already be expanded (askingPatternsInput has value)
    // If not visible, click to expand
    let askingPatternsTextarea = screen.queryByPlaceholderText(/enter one regex pattern per line/i);
    if (!askingPatternsTextarea) {
      const advancedButton = screen.getByRole('button', { name: /advanced settings/i });
      await user.click(advancedButton);
      askingPatternsTextarea = await screen.findByPlaceholderText(/enter one regex pattern per line/i);
    }

    // 4. Clear the askingPatterns textarea
    await user.clear(askingPatternsTextarea);

    // 5. Submit the form - this should send null for activityPatterns
    const submitButton = screen.getByRole('button', { name: /save changes/i });
    await user.click(submitButton);

    // 6. Wait for PATCH request to be sent
    await waitFor(() => {
      const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/agents/');
      expect(patchRequest).toBeDefined();
    });

    // 7. Verify client sent null (not undefined/omitted) in the JSON body
    const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/agents/');
    expect(patchRequest!.body).toHaveProperty('activityPatterns');
    expect((patchRequest!.body as Record<string, unknown>).activityPatterns).toBeNull();

    // 8. Verify server processed correctly - activityPatterns should be cleared
    const verifyRes = await app.request(`/api/agents/${created.id}`);
    expect(verifyRes.status).toBe(200);
    const { agent } = await verifyRes.json();
    expect(agent.activityPatterns).toBeUndefined();
  });

  it('should preserve activityPatterns when askingPatterns field has patterns', async () => {
    const user = userEvent.setup();

    // 1. Create agent without activityPatterns
    const createRes = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Agent 2',
        commandTemplate: 'test-cmd {{prompt}}',
      }),
    });
    expect(createRes.status).toBe(201);
    const { agent: created } = await createRes.json();
    expect(created.activityPatterns).toBeUndefined();

    // 2. Render EditAgentForm
    await renderWithQuery(
      <EditAgentForm
        agentId={created.id}
        initialData={{
          name: created.name,
          commandTemplate: created.commandTemplate,
          continueTemplate: '',
          headlessTemplate: '',
          description: '',
          askingPatternsInput: '',
        }}
        onSuccess={() => {}}
        onCancel={() => {}}
      />
    );

    // 3. Expand Advanced Settings
    const advancedButton = screen.getByRole('button', { name: /advanced settings/i });
    await user.click(advancedButton);

    // 4. Add patterns to textarea
    const askingPatternsTextarea = screen.getByPlaceholderText(/enter one regex pattern per line/i);
    await user.type(askingPatternsTextarea, 'new-pattern-1\nnew-pattern-2');

    // 5. Submit
    const submitButton = screen.getByRole('button', { name: /save changes/i });
    await user.click(submitButton);

    // 6. Wait for PATCH request
    await waitFor(() => {
      const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/agents/');
      expect(patchRequest).toBeDefined();
    });

    // 7. Verify client sent activityPatterns object (not null)
    const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/agents/');
    const body = patchRequest!.body as Record<string, unknown>;
    expect(body.activityPatterns).toEqual({
      askingPatterns: ['new-pattern-1', 'new-pattern-2'],
    });

    // 8. Verify server stored patterns
    const verifyRes = await app.request(`/api/agents/${created.id}`);
    const { agent } = await verifyRes.json();
    expect(agent.activityPatterns?.askingPatterns).toEqual(['new-pattern-1', 'new-pattern-2']);
  });

  it('normal flow: create agent with form, then edit patterns', async () => {
    const user = userEvent.setup();

    // === Phase 1: Create agent using AddAgentForm ===
    let createSuccess = false;
    await renderWithQuery(
      <AddAgentForm
        onSuccess={() => {
          createSuccess = true;
        }}
        onCancel={() => {}}
      />
    );

    // Fill in required fields (using placeholder because FormField multi-child doesn't inject id)
    const nameInput = screen.getByLabelText(/^name$/i);
    const commandInput = screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}}');
    await user.type(nameInput, 'My Custom Agent');
    // Use fireEvent for command template because userEvent interprets {} as special chars
    fireEvent.change(commandInput, { target: { value: 'my-agent --prompt {{prompt}}' } });

    // Expand Advanced Settings and add initial patterns
    const advancedButton = screen.getByRole('button', { name: /advanced settings/i });
    await user.click(advancedButton);
    const askingPatternsTextarea = await screen.findByPlaceholderText(/enter one regex pattern per line/i);
    await user.type(askingPatternsTextarea, 'initial-pattern-1\ninitial-pattern-2');

    // Submit create form
    const addButton = screen.getByRole('button', { name: /add agent/i });
    await user.click(addButton);

    // Wait for POST request
    await waitFor(() => {
      const postRequest = findRequest(bridge.capturedRequests, 'POST', '/api/agents');
      expect(postRequest).toBeDefined();
    });

    // Verify create request body
    const postRequest = findRequest(bridge.capturedRequests, 'POST', '/api/agents');
    const postBody = postRequest!.body as Record<string, unknown>;
    expect(postBody.name).toBe('My Custom Agent');
    expect(postBody.commandTemplate).toBe('my-agent --prompt {{prompt}}');
    expect(postBody.activityPatterns).toEqual({
      askingPatterns: ['initial-pattern-1', 'initial-pattern-2'],
    });

    // Wait for success callback
    await waitFor(() => {
      expect(createSuccess).toBe(true);
    });

    // Get created agent from server
    const listRes = await app.request('/api/agents');
    const { agents } = await listRes.json();
    const createdAgent = agents.find((a: { name: string }) => a.name === 'My Custom Agent');
    expect(createdAgent).toBeDefined();
    expect(createdAgent.activityPatterns?.askingPatterns).toEqual([
      'initial-pattern-1',
      'initial-pattern-2',
    ]);

    // === Phase 2: Edit the agent using EditAgentForm ===
    cleanup();
    bridge.capturedRequests.length = 0; // Clear captured requests

    let editSuccess = false;
    await renderWithQuery(
      <EditAgentForm
        agentId={createdAgent.id}
        initialData={{
          name: createdAgent.name,
          commandTemplate: createdAgent.commandTemplate,
          continueTemplate: '',
          headlessTemplate: '',
          description: '',
          askingPatternsInput: 'initial-pattern-1\ninitial-pattern-2',
        }}
        onSuccess={() => {
          editSuccess = true;
        }}
        onCancel={() => {}}
      />
    );

    // Expand Advanced Settings if not already visible
    let askingPatternsTextarea2 = screen.queryByPlaceholderText(/enter one regex pattern per line/i);
    if (!askingPatternsTextarea2) {
      const advancedButton2 = screen.getByRole('button', { name: /advanced settings/i });
      await user.click(advancedButton2);
      askingPatternsTextarea2 = await screen.findByPlaceholderText(/enter one regex pattern per line/i);
    }

    // Clear and type new patterns (modify: keep one, remove one, add one)
    await user.clear(askingPatternsTextarea2);
    await user.type(askingPatternsTextarea2, 'initial-pattern-1\nnew-pattern-3');

    // Submit edit form
    const saveButton = screen.getByRole('button', { name: /save changes/i });
    await user.click(saveButton);

    // Wait for PATCH request
    await waitFor(() => {
      const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/agents/');
      expect(patchRequest).toBeDefined();
    });

    // Verify edit request body
    const patchRequest = findRequest(bridge.capturedRequests, 'PATCH', '/api/agents/');
    const patchBody = patchRequest!.body as Record<string, unknown>;
    expect(patchBody.activityPatterns).toEqual({
      askingPatterns: ['initial-pattern-1', 'new-pattern-3'],
    });

    // Wait for success callback
    await waitFor(() => {
      expect(editSuccess).toBe(true);
    });

    // Verify server state after edit
    const verifyRes = await app.request(`/api/agents/${createdAgent.id}`);
    const { agent: updatedAgent } = await verifyRes.json();
    expect(updatedAgent.activityPatterns?.askingPatterns).toEqual([
      'initial-pattern-1',
      'new-pattern-3',
    ]);
  });
});
