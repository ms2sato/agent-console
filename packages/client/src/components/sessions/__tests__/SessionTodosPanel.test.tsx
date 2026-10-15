import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import type { Todo } from '@agent-console/shared';
import { screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { SessionTodosPanel } from '../SessionTodosPanel';

// Fetch-level mock (testing.md Anti-Pattern #2: mock at the fetch boundary).
const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = Object.assign(mockFetch, { preconnect: () => {} }) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-1',
    kind: 'action',
    scope: 'session',
    title: 'Run the migration',
    body: '',
    sessionId: 'session-1',
    createdBy: { workerId: 'worker-1' },
    assigneeUserId: null,
    status: 'open',
    resolutionText: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(props: { isExpanded?: boolean; compact?: boolean } = {}) {
  return renderWithRouter(
    <SessionTodosPanel
      sessionId="session-1"
      isExpanded={props.isExpanded ?? true}
      onToggleExpanded={() => {}}
      compact={props.compact ?? false}
    />
  );
}

/**
 * Measured reach, recorded by WHICH test failed (each mutation applied alone):
 *
 *   `openCount` counts every item (hooks/useSessionTodos.ts)
 *     -> 'renders nothing when the list holds only done items', 'counts only
 *        open items in the header ...', 'shows scope and kind badges ...',
 *        'renders nothing in compact mode at zero open items'
 *   the `openCount === 0` early return removed (SessionTodosPanel.tsx)
 *     -> 'renders nothing while the list is pending', 'renders nothing when
 *        the session has no items at all', 'renders nothing when the list
 *        holds only done items', 'renders nothing in compact mode at zero
 *        open items'
 */
describe('SessionTodosPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders nothing while the list is pending', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { container } = await renderPanel();

    expect(container.textContent).toBe('');
  });

  it('renders nothing when the session has no items at all', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [] }));

    const { container } = await renderPanel();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.textContent).toBe('');
    expect(screen.queryByLabelText('Collapse To-do')).toBeNull();
  });

  it('renders nothing when the list holds only done items (zero OPEN items)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', status: 'done', resolutionText: 'Done it' }),
          makeTodo({ id: 'b', status: 'dismissed', title: 'Dismissed one' }),
        ],
      })
    );

    const { container } = await renderPanel();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.textContent).toBe('');
    expect(screen.queryByText('Dismissed one')).toBeNull();
  });

  it('counts only open items in the header while listing every item', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', title: 'Open one' }),
          makeTodo({ id: 'b', title: 'Done one', status: 'done', resolutionText: 'ok' }),
          makeTodo({ id: 'c', title: 'Open global', scope: 'global' }),
        ],
      })
    );

    await renderPanel();

    expect(await screen.findByText('To-do (2)')).toBeTruthy();
    expect(screen.getByText('Open one')).toBeTruthy();
    expect(screen.getByText('Done one')).toBeTruthy();
    expect(screen.getByText('Open global')).toBeTruthy();
  });

  it('shows scope and kind badges on every item, and a status badge only on non-open items', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', title: 'Open question', kind: 'question' }),
          makeTodo({ id: 'b', title: 'Closed global', scope: 'global', status: 'superseded' }),
        ],
      })
    );

    await renderPanel();
    await screen.findByText('To-do (1)');

    expect(screen.getAllByLabelText('Scope: session')).toHaveLength(1);
    expect(screen.getAllByLabelText('Scope: global')).toHaveLength(1);
    expect(screen.getAllByLabelText('Kind: question')).toHaveLength(1);
    expect(screen.getAllByLabelText('Kind: action')).toHaveLength(1);
    expect(screen.getAllByLabelText(/^Status: /)).toHaveLength(1);
    expect(screen.getByLabelText('Status: superseded')).toBeTruthy();
    expect(screen.queryByLabelText('Status: open')).toBeNull();
  });

  it('renders the body as markdown, including a fenced block', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [makeTodo({ body: '**bold text**\n\n```sh\nbun run migrate\n```' })],
      })
    );

    await renderPanel();

    const bold = await screen.findByText('bold text');
    expect(bold.tagName).toBe('STRONG');
    expect(screen.getByText('bun run migrate')).toBeTruthy();
  });

  it('shows the resolution text of a resolved item', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        todos: [
          makeTodo({ id: 'a', title: 'Open one' }),
          makeTodo({ id: 'b', status: 'done', resolutionText: 'Use option B' }),
        ],
      })
    );

    await renderPanel();

    expect(await screen.findByText('Use option B')).toBeTruthy();
  });

  it('collapses through the header toggle', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [makeTodo()] }));
    const onToggle = mock(() => {});

    await renderWithRouter(
      <SessionTodosPanel sessionId="session-1" isExpanded onToggleExpanded={onToggle} compact={false} />
    );

    fireEvent.click(await screen.findByLabelText('Collapse To-do'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows only a labelled rail button with the open count in compact mode', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [makeTodo()] }));

    await renderPanel({ compact: true });

    expect(await screen.findByLabelText('Expand to-do')).toBeTruthy();
    expect(screen.getByText('To-do (1)')).toBeTruthy();
    expect(screen.queryByText('Run the migration')).toBeNull();
  });

  it('renders nothing in compact mode at zero open items', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ todos: [makeTodo({ status: 'done', resolutionText: 'x' })] }));

    const { container } = await renderPanel({ compact: true });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.textContent).toBe('');
  });
});
