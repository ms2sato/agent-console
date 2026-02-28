import { describe, it, expect, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { QuickSessionSettingsMenu } from '../QuickSessionSettingsMenu';

afterEach(() => {
  cleanup();
});

describe('QuickSessionSettingsMenu', () => {
  it('should have aria-label="Session settings" on the trigger button', () => {
    render(
      <QuickSessionSettingsMenu onMenuAction={() => {}} />
    );

    const button = screen.getByRole('button', { name: 'Session settings' });
    expect(button).toBeTruthy();
  });
});
