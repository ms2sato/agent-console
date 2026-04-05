import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { TerminalLoadingBar } from '../TerminalLoadingBar';

describe('TerminalLoadingBar', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders progress bar when visible is true', () => {
    render(<TerminalLoadingBar visible={true} />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('does not render when visible is false', () => {
    render(<TerminalLoadingBar visible={false} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('has correct accessibility attributes', () => {
    render(<TerminalLoadingBar visible={true} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Loading terminal history');
  });
});
