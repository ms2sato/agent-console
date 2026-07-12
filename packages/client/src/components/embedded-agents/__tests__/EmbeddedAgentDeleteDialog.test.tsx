import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EmbeddedAgentDefinition, Session, EmbeddedAgentWorker } from '@agent-console/shared';
import { EmbeddedAgentDeleteDialog } from '../EmbeddedAgentDeleteDialog';
import type { EmbeddedAgentWorkerReference } from '../findReferencingWorkers';

afterEach(() => {
  cleanup();
});

const embeddedAgent: EmbeddedAgentDefinition = {
  id: 'embedded-1',
  name: 'Ollama qwen3',
  provider: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' },
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeReference(sessionTitle: string | undefined, workerName: string): EmbeddedAgentWorkerReference {
  const worker: EmbeddedAgentWorker = {
    id: 'worker-1',
    name: workerName,
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'embedded-agent',
    embeddedAgentId: 'embedded-1',
    activated: true,
  };
  const session: Session = {
    id: 'session-1',
    type: 'quick',
    locationPath: '/tmp/session-1',
    status: 'active',
    activationState: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    workers: [worker],
    title: sessionTitle,
    isShared: false,
    recoveryState: 'healthy',
  };
  return { session, worker };
}

describe('EmbeddedAgentDeleteDialog', () => {
  it('renders a plain confirmation with no warning when there are no references', () => {
    render(
      <EmbeddedAgentDeleteDialog
        embeddedAgent={embeddedAgent}
        referencingWorkers={[]}
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText('Delete Embedded Agent')).toBeTruthy();
    expect(screen.getByText('Are you sure you want to delete "Ollama qwen3"?')).toBeTruthy();
    expect(screen.queryByText(/still reference this definition/)).toBeNull();
  });

  it('renders the reference list warning when live workers reference the definition', () => {
    const reference = makeReference('My Session', 'My Worker');

    render(
      <EmbeddedAgentDeleteDialog
        embeddedAgent={embeddedAgent}
        referencingWorkers={[reference]}
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText(/1 worker still reference this definition/)).toBeTruthy();
    expect(screen.getByText(/"My Worker" in session "My Session"/)).toBeTruthy();
  });

  it('falls back to locationPath when the session has no title', () => {
    const reference = makeReference(undefined, 'My Worker');

    render(
      <EmbeddedAgentDeleteDialog
        embeddedAgent={embeddedAgent}
        referencingWorkers={[reference]}
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText(/"My Worker" in session "\/tmp\/session-1"/)).toBeTruthy();
  });

  it('calls onConfirm when the delete button is clicked, even with references present', async () => {
    const user = userEvent.setup();
    const onConfirm = mock(() => {});
    const reference = makeReference('My Session', 'My Worker');

    render(
      <EmbeddedAgentDeleteDialog
        embeddedAgent={embeddedAgent}
        referencingWorkers={[reference]}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />
    );

    await user.click(screen.getByText('Delete'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is closed when embeddedAgent is null', () => {
    render(
      <EmbeddedAgentDeleteDialog
        embeddedAgent={null}
        referencingWorkers={[]}
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.queryByText('Delete Embedded Agent')).toBeNull();
  });
});
