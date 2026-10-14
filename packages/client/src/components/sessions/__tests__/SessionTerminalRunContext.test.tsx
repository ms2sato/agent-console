import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionTerminalRunContext, useSessionTerminalRun, type SessionTerminalRun } from '../SessionTerminalRunContext';

function Probe() {
  const run = useSessionTerminalRun();
  return <span data-testid="probe">{run ? run.terminalWorkers.map((w) => w.name).join(',') : 'none'}</span>;
}

describe('SessionTerminalRunContext', () => {
  afterEach(() => cleanup());

  it('yields null outside a provider, so consumers offer no Run control', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });

  it('yields the provided value inside a provider', () => {
    const value: SessionTerminalRun = {
      terminalWorkers: [{ id: 't1', name: 'Shell 1' }],
      activateWorker: () => {},
      createTerminalWorker: async () => null,
    };
    render(
      <SessionTerminalRunContext.Provider value={value}>
        <Probe />
      </SessionTerminalRunContext.Provider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('Shell 1');
  });
});
