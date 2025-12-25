import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup, act } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { InitialPromptDialog } from '../InitialPromptDialog';

describe('InitialPromptDialog', () => {
  afterEach(() => {
    cleanup();
  });

  const defaultProps = {
    open: true,
    onOpenChange: mock(() => {}),
  };

  it('should display the initial prompt when provided', async () => {
    const testPrompt = 'This is a test prompt with content';
    await act(async () => {
      await renderWithRouter(
        <InitialPromptDialog {...defaultProps} initialPrompt={testPrompt} />
      );
    });

    expect(screen.getByText('Initial Prompt')).toBeTruthy();
    // Use getById since the pre element has a specific id
    const promptElement = document.getElementById('initial-prompt-content');
    expect(promptElement).toBeTruthy();
    expect(promptElement?.textContent).toBe(testPrompt);
  });

  it('should display "No initial prompt available" when no prompt is provided', async () => {
    await act(async () => {
      await renderWithRouter(
        <InitialPromptDialog {...defaultProps} initialPrompt={undefined} />
      );
    });

    expect(screen.getByText('Initial Prompt')).toBeTruthy();
    expect(screen.getByText('No initial prompt available')).toBeTruthy();
  });

  it('should preserve whitespace formatting in the prompt', async () => {
    const testPrompt = 'Line 1\n  Indented line\n    Double indented';
    await act(async () => {
      await renderWithRouter(
        <InitialPromptDialog {...defaultProps} initialPrompt={testPrompt} />
      );
    });

    // Use getById since the pre element has a specific id
    const promptElement = document.getElementById('initial-prompt-content');
    expect(promptElement).toBeTruthy();
    expect(promptElement?.tagName.toLowerCase()).toBe('pre');
    // The textContent should preserve the original whitespace
    expect(promptElement?.textContent).toBe(testPrompt);
  });

  it('should call onOpenChange when close button is clicked', async () => {
    const onOpenChange = mock(() => {});
    await act(async () => {
      await renderWithRouter(
        <InitialPromptDialog
          open={true}
          onOpenChange={onOpenChange}
          initialPrompt="test"
        />
      );
    });

    // Click the close button (sr-only text "Close")
    const closeButton = screen.getByRole('button', { name: 'Close' });
    await act(async () => {
      fireEvent.click(closeButton);
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('should not render content when dialog is closed', async () => {
    await act(async () => {
      await renderWithRouter(
        <InitialPromptDialog
          open={false}
          onOpenChange={mock(() => {})}
          initialPrompt="test prompt"
        />
      );
    });

    expect(screen.queryByText('Initial Prompt')).toBeNull();
    expect(document.getElementById('initial-prompt-content')).toBeNull();
  });
});
