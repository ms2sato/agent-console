import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { TodoBodyMarkdown } from '../TodoBodyMarkdown';

afterEach(() => {
  cleanup();
});

describe('TodoBodyMarkdown', () => {
  it('renders markdown emphasis and lists', () => {
    render(<TodoBodyMarkdown body={'**bold** and\n\n- one\n- two'} focusable />);

    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('takes links out of the tab order when not focusable', () => {
    render(<TodoBodyMarkdown body="[docs](https://example.com)" focusable={false} />);

    expect(screen.getByText('docs').closest('a')?.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps links in the tab order when focusable', () => {
    render(<TodoBodyMarkdown body="[docs](https://example.com)" focusable />);

    expect(screen.getByText('docs').closest('a')?.hasAttribute('tabindex')).toBe(false);
  });

  it('offers Copy on a fenced block, and Run on a terminal block only when onRun is given', () => {
    const onRun = mock((_command: string) => {});
    render(<TodoBodyMarkdown body={'```terminal\nls -la\n```'} focusable onRun={onRun} />);
    expect(screen.getByRole('button', { name: /run/i })).toBeTruthy();
    cleanup();

    render(<TodoBodyMarkdown body={'```terminal\nls -la\n```'} focusable />);
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull();
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
  });
});
