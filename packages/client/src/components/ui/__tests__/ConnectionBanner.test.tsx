import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ConnectionBanner } from '../ConnectionBanner';

describe('ConnectionBanner', () => {
  afterEach(() => {
    cleanup();
  });

  it('should not render when connected', () => {
    const { container } = render(
      <ConnectionBanner connected={true} hasEverConnected={true} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('should not render on initial load before first connection', () => {
    const { container } = render(
      <ConnectionBanner connected={false} hasEverConnected={false} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('should render reconnection banner after losing a previous connection', () => {
    render(
      <ConnectionBanner connected={false} hasEverConnected={true} />
    );

    expect(screen.getByText('Real-time updates disconnected. Reconnecting...')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
