import { describe, it, expect, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { BellIcon } from '../Icons';

afterEach(() => {
  cleanup();
});

describe('BellIcon', () => {
  it('renders an svg with the default className', () => {
    const { container } = render(<BellIcon />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('class')).toBe('w-4 h-4');
  });

  it('applies a custom className override', () => {
    const { container } = render(<BellIcon className="w-5 h-5" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toBe('w-5 h-5');
  });
});
