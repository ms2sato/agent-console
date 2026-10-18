import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HookCommandFailureDialog } from '../HookCommandFailureDialog';

afterEach(() => {
  cleanup();
});

describe('HookCommandFailureDialog', () => {
  it('renders the title, intro, error text, output and hint', () => {
    render(
      <HookCommandFailureDialog
        result={{ success: false, error: 'exit code 3', output: 'container not found' }}
        title="Pause Command Failed"
        intro="The session was paused, but the pause command failed."
        hint="Check the repository settings."
        onClose={mock(() => {})}
      />
    );

    expect(screen.getByText('Pause Command Failed')).toBeTruthy();
    expect(screen.getByText('The session was paused, but the pause command failed.')).toBeTruthy();
    expect(screen.getByText('exit code 3')).toBeTruthy();
    expect(screen.getByText('container not found')).toBeTruthy();
    expect(screen.getByText('Check the repository settings.')).toBeTruthy();
  });

  it('renders the title in the destructive (red) style', () => {
    render(
      <HookCommandFailureDialog
        result={{ success: false, error: 'boom' }}
        title="Setup Command Failed"
        intro="intro"
        onClose={mock(() => {})}
      />
    );

    expect(screen.getByText('Setup Command Failed').className).toContain('text-red-400');
  });

  it('omits the output block and hint when they are absent', () => {
    render(
      <HookCommandFailureDialog
        result={{ success: false, error: 'boom' }}
        title="T"
        intro="intro"
        onClose={mock(() => {})}
      />
    );

    expect(screen.queryByText('Output:')).toBeNull();
  });

  it('renders nothing while result is null', () => {
    render(
      <HookCommandFailureDialog result={null} title="Resume Command Failed" intro="intro" onClose={mock(() => {})} />
    );

    expect(screen.queryByText('Resume Command Failed')).toBeNull();
  });

  it('calls onClose when OK is clicked', () => {
    const onClose = mock(() => {});
    render(
      <HookCommandFailureDialog result={{ success: false, error: 'boom' }} title="T" intro="intro" onClose={onClose} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
