import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { QuickSessionSettingsMenu } from '../QuickSessionSettingsMenu';

afterEach(() => {
  cleanup();
});

describe('QuickSessionSettingsMenu', () => {
  it('should have aria-label="Session settings" on the trigger button', () => {
    render(
      <QuickSessionSettingsMenu onMenuAction={() => {}} />
    );

    const button = screen.getByRole('button', { name: 'Session settings' });
    expect(button).toBeTruthy();
  });

  describe('stopDisabled (Issue #1247)', () => {
    it('disables the Stop Session menu entry and does not fire onMenuAction when clicked', async () => {
      const onMenuAction = mock(() => {});
      render(<QuickSessionSettingsMenu stopDisabled onMenuAction={onMenuAction} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
      });

      const stopButton = screen.getByRole('button', { name: /Stop Session/ });
      expect((stopButton as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(stopButton);
      expect(onMenuAction).not.toHaveBeenCalled();
    });

    it('leaves the Stop Session menu entry enabled by default', async () => {
      const onMenuAction = mock(() => {});
      render(<QuickSessionSettingsMenu onMenuAction={onMenuAction} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Session settings' }));
      });

      const stopButton = screen.getByRole('button', { name: /Stop Session/ });
      expect((stopButton as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(stopButton);
      expect(onMenuAction).toHaveBeenCalledWith('stop-session');
    });
  });
});
