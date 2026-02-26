import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { WorkerErrorCode } from '@agent-console/shared';
import { WorkerErrorRecovery, type WorkerErrorRecoveryProps } from '../WorkerErrorRecovery';

function renderComponent(props: Partial<WorkerErrorRecoveryProps> & { errorMessage: string }) {
  return render(<WorkerErrorRecovery {...props} />);
}

describe('WorkerErrorRecovery', () => {
  afterEach(() => {
    cleanup();
  });

  describe('error code to title and description', () => {
    it('shows "Session Deleted" for SESSION_DELETED', () => {
      renderComponent({ errorCode: 'SESSION_DELETED', errorMessage: 'test error' });

      expect(screen.getByText('Session Deleted')).toBeTruthy();
      expect(screen.getByText('This session has been deleted.')).toBeTruthy();
    });

    it('shows "Worker Not Found" for WORKER_NOT_FOUND', () => {
      renderComponent({ errorCode: 'WORKER_NOT_FOUND', errorMessage: 'test error' });

      expect(screen.getByText('Worker Not Found')).toBeTruthy();
      expect(screen.getByText(/Restart/)).toBeTruthy();
    });

    it('shows "Failed to Start Worker" for ACTIVATION_FAILED', () => {
      renderComponent({ errorCode: 'ACTIVATION_FAILED', errorMessage: 'test error' });

      expect(screen.getByText('Failed to Start Worker')).toBeTruthy();
    });

    it('shows "Directory Not Found" for PATH_NOT_FOUND', () => {
      renderComponent({ errorCode: 'PATH_NOT_FOUND', errorMessage: 'test error' });

      expect(screen.getByText('Directory Not Found')).toBeTruthy();
    });

    it('shows "Agent Not Available" for AGENT_NOT_FOUND', () => {
      renderComponent({ errorCode: 'AGENT_NOT_FOUND', errorMessage: 'test error' });

      expect(screen.getByText('Agent Not Available')).toBeTruthy();
    });

    it('shows "History Load Failed" for HISTORY_LOAD_FAILED', () => {
      renderComponent({ errorCode: 'HISTORY_LOAD_FAILED', errorMessage: 'test error' });

      expect(screen.getByText('History Load Failed')).toBeTruthy();
    });

    it('shows "Worker Error" when no error code is provided', () => {
      renderComponent({ errorMessage: 'test error' });

      expect(screen.getByText('Worker Error')).toBeTruthy();
    });
  });

  describe('error code to action buttons', () => {
    it('shows "Go to Dashboard" button for SESSION_DELETED (not "Delete Session")', () => {
      renderComponent({
        errorCode: 'SESSION_DELETED',
        errorMessage: 'test error',
        onGoToDashboard: mock(() => {}),
      });

      expect(screen.getByRole('button', { name: 'Go to Dashboard' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Delete Session/ })).toBeNull();
    });

    it('shows "Continue (-c)", "New Session", and "Dashboard" buttons for WORKER_NOT_FOUND', () => {
      renderComponent({
        errorCode: 'WORKER_NOT_FOUND',
        errorMessage: 'test error',
        onRestart: mock(() => {}),
        onGoToDashboard: mock(() => {}),
      });

      expect(screen.getByRole('button', { name: 'Continue (-c)' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'New Session' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
    });

    it('shows "Reconnect" button for ACTIVATION_FAILED', () => {
      renderComponent({
        errorCode: 'ACTIVATION_FAILED',
        errorMessage: 'test error',
        onRetry: mock(() => {}),
      });

      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    });

    it('shows "Delete Session" button for PATH_NOT_FOUND', () => {
      renderComponent({
        errorCode: 'PATH_NOT_FOUND',
        errorMessage: 'test error',
        onDeleteSession: mock(() => {}),
      });

      expect(screen.getByRole('button', { name: 'Delete Session' })).toBeTruthy();
    });

    it('shows "Reconnect" button for default (no error code)', () => {
      renderComponent({
        errorMessage: 'test error',
        onRetry: mock(() => {}),
      });

      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    });
  });

  describe('button click handlers', () => {
    it('calls onGoToDashboard when "Go to Dashboard" is clicked for SESSION_DELETED', () => {
      const onGoToDashboard = mock(() => {});

      renderComponent({
        errorCode: 'SESSION_DELETED',
        errorMessage: 'test error',
        onGoToDashboard,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }));
      expect(onGoToDashboard).toHaveBeenCalledTimes(1);
    });

    it('calls onRestart(true) when "Continue (-c)" is clicked for WORKER_NOT_FOUND', () => {
      const onRestart = mock((_continueConversation: boolean) => {});

      renderComponent({
        errorCode: 'WORKER_NOT_FOUND',
        errorMessage: 'test error',
        onRestart,
        onGoToDashboard: mock(() => {}),
      });

      fireEvent.click(screen.getByRole('button', { name: 'Continue (-c)' }));
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(onRestart.mock.calls[0][0]).toBe(true);
    });

    it('calls onRestart(false) when "New Session" is clicked for WORKER_NOT_FOUND', () => {
      const onRestart = mock((_continueConversation: boolean) => {});

      renderComponent({
        errorCode: 'WORKER_NOT_FOUND',
        errorMessage: 'test error',
        onRestart,
        onGoToDashboard: mock(() => {}),
      });

      fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(onRestart.mock.calls[0][0]).toBe(false);
    });

    it('calls onGoToDashboard when "Dashboard" is clicked for WORKER_NOT_FOUND', () => {
      const onGoToDashboard = mock(() => {});

      renderComponent({
        errorCode: 'WORKER_NOT_FOUND',
        errorMessage: 'test error',
        onRestart: mock(() => {}),
        onGoToDashboard,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      expect(onGoToDashboard).toHaveBeenCalledTimes(1);
    });

    it('calls onRetry when "Reconnect" is clicked for ACTIVATION_FAILED', () => {
      const onRetry = mock(() => {});

      renderComponent({
        errorCode: 'ACTIVATION_FAILED',
        errorMessage: 'test error',
        onRetry,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('calls onRetry when "Reconnect" is clicked for default (no error code)', () => {
      const onRetry = mock(() => {});

      renderComponent({
        errorMessage: 'test error',
        onRetry,
      });

      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('shows fallback Dashboard and Reconnect buttons for WORKER_NOT_FOUND when onRestart is not provided', () => {
      const onGoToDashboard = mock(() => {});
      const onRetry = mock(() => {});

      renderComponent({
        errorCode: 'WORKER_NOT_FOUND',
        errorMessage: 'test error',
        onGoToDashboard,
        onRetry,
      });

      // Should NOT show Continue or New Session since onRestart is not provided
      expect(screen.queryByRole('button', { name: 'Continue (-c)' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New Session' })).toBeNull();

      // Should show fallback buttons
      expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();

      // Verify click handlers work
      fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
      expect(onGoToDashboard).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('shows no buttons for WORKER_NOT_FOUND when onRestart, onGoToDashboard, and onRetry are all missing', () => {
      renderComponent({
        errorCode: 'WORKER_NOT_FOUND',
        errorMessage: 'test error',
      });

      // No action buttons should be rendered
      expect(screen.queryByRole('button', { name: 'Continue (-c)' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New Session' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dashboard' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    });
  });

  describe('error message display', () => {
    const errorCodes: (WorkerErrorCode | undefined)[] = [
      'SESSION_DELETED',
      'WORKER_NOT_FOUND',
      'ACTIVATION_FAILED',
      'PATH_NOT_FOUND',
      'AGENT_NOT_FOUND',
      'HISTORY_LOAD_FAILED',
      undefined,
    ];

    for (const errorCode of errorCodes) {
      it(`displays error message text for ${errorCode ?? 'undefined (default)'}`, () => {
        renderComponent({
          errorCode,
          errorMessage: 'Something specific went wrong',
        });

        expect(screen.getByText('Something specific went wrong')).toBeTruthy();
      });
    }
  });
});
