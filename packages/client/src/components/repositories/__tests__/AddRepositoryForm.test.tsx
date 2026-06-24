import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddRepositoryForm } from '../AddRepositoryForm';
import { renderWithRouter } from '../../../test/renderWithRouter';

// Save original fetch (CloneFromUrlForm uses fetch via the api client)
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
});

async function renderAddRepositoryForm(props: Partial<React.ComponentProps<typeof AddRepositoryForm>> = {}) {
  const defaultProps = {
    isPending: false,
    onSubmit: mock(() => Promise.resolve()),
    onCancel: mock(() => {}),
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...(await renderWithRouter(<AddRepositoryForm {...mergedProps} />)),
    props: mergedProps,
  };
}

describe('AddRepositoryForm', () => {
  describe('tab structure', () => {
    it('renders Clone from URL and Use existing path tabs', async () => {
      await renderAddRepositoryForm();

      const cloneTab = screen.getByRole('tab', { name: 'Clone from URL' });
      const existingTab = screen.getByRole('tab', { name: 'Use existing path' });

      expect(cloneTab).toBeTruthy();
      expect(existingTab).toBeTruthy();
    });

    it('defaults to the Clone from URL tab', async () => {
      await renderAddRepositoryForm();

      const cloneTab = screen.getByRole('tab', { name: 'Clone from URL' });
      expect(cloneTab.getAttribute('aria-selected')).toBe('true');
      // The URL input is visible on the clone tab.
      expect(screen.getByPlaceholderText(/https:\/\/github\.com/)).toBeTruthy();
    });

    it('switches to the Use existing path tab when clicked', async () => {
      const user = userEvent.setup();
      await renderAddRepositoryForm();

      const existingTab = screen.getByRole('tab', { name: 'Use existing path' });
      await user.click(existingTab);

      expect(existingTab.getAttribute('aria-selected')).toBe('true');
      // The path input is visible on the existing path tab.
      expect(screen.getByPlaceholderText(/Repository path/)).toBeTruthy();
    });
  });

  describe('Use existing path tab (delegates to parent onSubmit)', () => {
    it('submits successfully with valid path', async () => {
      const user = userEvent.setup();
      const { props } = await renderAddRepositoryForm();

      // Switch to existing-path tab
      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));

      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '/path/to/repo');

      await user.click(screen.getByText('Add'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0]).toMatchObject({ path: '/path/to/repo' });
    });

    it('shows validation error when path is empty', async () => {
      const user = userEvent.setup();
      const { props } = await renderAddRepositoryForm();

      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));
      await user.click(screen.getByText('Add'));

      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByText(/Path is required/)).toBeTruthy();
      });
    });

    it('displays root error when onSubmit throws', async () => {
      const user = userEvent.setup();
      const onSubmit = mock(() => Promise.reject(new Error('Repository not found')));
      await renderAddRepositoryForm({ onSubmit });

      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));

      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '/invalid/path');
      await user.click(screen.getByText('Add'));

      await waitFor(() => {
        expect(screen.getByText('Repository not found')).toBeTruthy();
      });
    });

    it('shows validation error when auto-generate is off and description is blank', async () => {
      const user = userEvent.setup();
      const { props } = await renderAddRepositoryForm();

      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));

      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '/path/to/repo');

      const autoGenerateCheckbox = screen.getByLabelText(/Auto-generate description/);
      await user.click(autoGenerateCheckbox);

      await user.click(screen.getByText('Add'));

      await waitFor(() => {
        expect(props.onSubmit).not.toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByText(/Description is required/)).toBeTruthy();
      });
    });

    it('submits successfully when auto-generate is on and description is blank', async () => {
      const user = userEvent.setup();
      const { props } = await renderAddRepositoryForm();

      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));

      const pathInput = screen.getByPlaceholderText(/Repository path/);
      await user.type(pathInput, '/path/to/repo');

      await user.click(screen.getByText('Add'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      expect(submitCall[0].autoGenerateDescription).toBe(true);
    });

    it('disables form when isPending is true', async () => {
      const user = userEvent.setup();
      await renderAddRepositoryForm({ isPending: true });

      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));

      expect(screen.getByText('Adding repository...')).toBeTruthy();

      const pathInput = screen.getByPlaceholderText(/Repository path/);
      expect(pathInput.closest('fieldset')?.disabled).toBe(true);
    });

    it('calls onCancel when the cancel button on the existing tab is clicked', async () => {
      const user = userEvent.setup();
      const { props } = await renderAddRepositoryForm();

      await user.click(screen.getByRole('tab', { name: 'Use existing path' }));

      const cancelButton = screen.getByText('Cancel');
      await user.click(cancelButton);

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
