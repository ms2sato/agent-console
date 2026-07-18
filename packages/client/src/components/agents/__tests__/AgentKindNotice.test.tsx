import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentKindNotice } from '../AgentKindNotice';

afterEach(() => {
  cleanup();
});

describe('AgentKindNotice', () => {
  it('renders the registered notice for embedded+restart', () => {
    render(<AgentKindNotice kind="embedded" context="restart" />);

    expect(
      screen.getByText(/Restarting into an embedded agent requires cross-type restart support/)
    ).toBeTruthy();
  });

  it('renders nothing for terminal+restart (no notice registered)', () => {
    const { container } = render(<AgentKindNotice kind="terminal" context="restart" />);

    expect(container.textContent).toBe('');
  });
});
