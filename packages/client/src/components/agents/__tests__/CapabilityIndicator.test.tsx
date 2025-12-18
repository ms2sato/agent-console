import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { CapabilityIndicator } from '../CapabilityIndicator';

afterEach(() => {
  cleanup();
});

describe('CapabilityIndicator', () => {
  it('should render enabled state with checkmark', () => {
    render(<CapabilityIndicator enabled={true} label="Continue" />);

    const element = screen.getByText(/Continue/);
    expect(element.textContent).toContain('✓');
    expect(element.className).toContain('text-green-400');
  });

  it('should render disabled state with X', () => {
    render(<CapabilityIndicator enabled={false} label="Headless" />);

    const element = screen.getByText(/Headless/);
    expect(element.textContent).toContain('✗');
    expect(element.className).toContain('text-gray-600');
  });
});
