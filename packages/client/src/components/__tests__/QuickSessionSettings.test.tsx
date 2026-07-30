import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QuickSessionSettings } from '../QuickSessionSettings';
import { SessionStopTasksContext } from '../../contexts/root-contexts';
import type { UseSessionStopTasksReturn } from '../../hooks/useSessionStopTasks';

afterEach(() => {
  cleanup();
});

function createMockSessionStopTasks(): UseSessionStopTasksReturn {
  return {
    tasks: [],
    addTask: mock(() => true),
    removeTask: mock(() => {}),
    getTask: mock(() => undefined),
    markAsFailed: mock(() => {}),
  };
}

function renderQuickSessionSettings(props: Partial<React.ComponentProps<typeof QuickSessionSettings>> = {}) {
  // QuickSessionSettings always mounts EndSessionDialog (visibility is
  // controlled by its `open` prop, not conditional rendering), so it always
  // calls useSessionStopTasksContext() and requires a Provider ancestor.
  return render(
    <SessionStopTasksContext.Provider value={createMockSessionStopTasks()}>
      <QuickSessionSettings sessionId="session-1" {...props} />
    </SessionStopTasksContext.Provider>
  );
}

describe('QuickSessionSettings / stopDisabled threading (Issue #1247)', () => {
  it('disables the Stop Session menu entry when stopDisabled is true', async () => {
    renderQuickSessionSettings({ stopDisabled: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
    });

    const stopButton = screen.getByRole('button', { name: /Stop Session/ });
    expect((stopButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the Stop Session menu entry enabled when stopDisabled is false/omitted', async () => {
    renderQuickSessionSettings();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
    });

    const stopButton = screen.getByRole('button', { name: /Stop Session/ });
    expect((stopButton as HTMLButtonElement).disabled).toBe(false);
  });
});
