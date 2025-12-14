import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddRepositoryForm } from '../AddRepositoryForm';

// Save original fetch (not used by this form, but keep consistent pattern)
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

function renderAddRepositoryForm(props: Partial<React.ComponentProps<typeof AddRepositoryForm>> = {}) {
  const defaultProps = {
    isPending: false,
    onSubmit: mock(() => Promise.resolve()),
    onCancel: mock(() => {}),
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(<AddRepositoryForm {...mergedProps} />),
    props: mergedProps,
  };
}

describe('AddRepositoryForm', () => {
  describe('successful submission', () => {
    it('should submit successfully with valid path', async () => {
      const user = userEvent.setup();
      const { props } = renderAddRepositoryForm();

      // Fill in repository path
      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '/path/to/repo');

      // Submit form
      const submitButton = screen.getByText('Add');
      await user.click(submitButton);

      // Verify onSubmit was called with correct data
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({
        path: '/path/to/repo',
      });
    });

    it('should trim whitespace from path', async () => {
      const user = userEvent.setup();
      const { props } = renderAddRepositoryForm();

      // Fill in repository path with whitespace
      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '  /path/to/repo  ');

      // Submit form
      const submitButton = screen.getByText('Add');
      await user.click(submitButton);

      // Verify path is trimmed
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].path).toBe('/path/to/repo');
    });
  });

  describe('validation errors', () => {
    it('should show validation error when path is empty', async () => {
      const user = userEvent.setup();
      const { props } = renderAddRepositoryForm();

      // Submit without filling anything
      const submitButton = screen.getByText('Add');
      await user.click(submitButton);

      // onSubmit should NOT be called
      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText(/Path is required/)).toBeTruthy();
      });
    });

    /**
     * This test ensures form submission works when path field has empty string
     * as default value (similar to the CreateWorktreeForm bug).
     * The form uses defaultValues: { path: '' }
     */
    it('should show validation error when submitting with empty default value', async () => {
      const user = userEvent.setup();
      const { props } = renderAddRepositoryForm();

      // Submit immediately - path is '' from defaultValues
      const submitButton = screen.getByText('Add');
      await user.click(submitButton);

      // onSubmit should NOT be called
      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });

      // Error should be displayed (validation should catch empty path)
      await waitFor(() => {
        expect(screen.getByText(/Path is required/)).toBeTruthy();
      });
    });
  });

  describe('error handling', () => {
    it('should display root error when onSubmit throws', async () => {
      const user = userEvent.setup();
      const onSubmit = mock(() => Promise.reject(new Error('Repository not found')));
      renderAddRepositoryForm({ onSubmit });

      // Fill in repository path
      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '/invalid/path');

      // Submit form
      const submitButton = screen.getByText('Add');
      await user.click(submitButton);

      // Error should be displayed
      await waitFor(() => {
        expect(screen.getByText('Repository not found')).toBeTruthy();
      });
    });
  });

  describe('UI state', () => {
    it('should disable form when isPending is true', () => {
      renderAddRepositoryForm({ isPending: true });

      // Form overlay should be visible with loading message
      expect(screen.getByText('Adding repository...')).toBeTruthy();

      // Form fields should be disabled via fieldset
      const pathInput = screen.getByPlaceholderText(/Repository path/);
      expect(pathInput.closest('fieldset')?.disabled).toBe(true);
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderAddRepositoryForm();

      // Click cancel
      const cancelButton = screen.getByText('Cancel');
      await user.click(cancelButton);

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
