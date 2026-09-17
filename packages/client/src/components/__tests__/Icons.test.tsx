import { describe, it, expect, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { BellIcon, FlagIcon, PanelRightIcon } from '../Icons';

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

describe('FlagIcon', () => {
  it('renders unfilled by default', () => {
    const { container } = render(<FlagIcon />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('fill')).toBe('none');
  });

  it('renders filled when filled is true', () => {
    const { container } = render(<FlagIcon filled />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
  });
});

describe('PanelRightIcon', () => {
  it('renders a stroke icon with the default className', () => {
    const { container } = render(<PanelRightIcon />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('class')).toBe('w-4 h-4');
    expect(svg?.getAttribute('fill')).toBe('none');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
  });

  it('applies a custom className override', () => {
    const { container } = render(<PanelRightIcon className="w-5 h-5" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('w-5 h-5');
  });
});
