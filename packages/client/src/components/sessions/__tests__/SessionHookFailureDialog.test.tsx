import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SessionHookFailureDialog } from '../SessionHookFailureDialog';

afterEach(() => {
  cleanup();
});

describe('SessionHookFailureDialog', () => {
  it('shows the pause title, the paused intro and the error text', () => {
    render(
      <SessionHookFailureDialog
        failure={{ kind: 'pause', sessionTitle: 'My Session', result: { success: false, error: 'docker: not found' } }}
        onClose={mock(() => {})}
      />
    );

    expect(screen.getByText('Pause Command Failed')).toBeTruthy();
    expect(screen.getByText(/The session was paused, but the pause command failed/)).toBeTruthy();
    expect(screen.getByText(/My Session/)).toBeTruthy();
    expect(screen.getByText('docker: not found')).toBeTruthy();
  });

  it('shows the resume title and intro', () => {
    render(
      <SessionHookFailureDialog
        failure={{ kind: 'resume', result: { success: false, error: 'start failed' } }}
        onClose={mock(() => {})}
      />
    );

    expect(screen.getByText('Resume Command Failed')).toBeTruthy();
    expect(screen.getByText(/The session was resumed, but the resume command failed/)).toBeTruthy();
    expect(screen.getByText('start failed')).toBeTruthy();
  });

  it('renders nothing without a failure, and calls onClose on OK', () => {
    const onClose = mock(() => {});
    const { rerender } = render(<SessionHookFailureDialog failure={null} onClose={onClose} />);
    expect(screen.queryByText('Pause Command Failed')).toBeNull();

    rerender(<SessionHookFailureDialog failure={{ kind: 'pause', result: { success: false } }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
