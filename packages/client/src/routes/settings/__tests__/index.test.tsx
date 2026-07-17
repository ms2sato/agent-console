/**
 * Tests for the Settings page after Issue #1178 Option B (deprecate agent
 * management on Settings): the full agent add/edit/delete UI has been
 * removed and replaced with a note pointing to the Agents page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';

import { SettingsPage } from '../index';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { setServerPort, _reset as resetServerInfo } from '../../../lib/server-info';

beforeEach(() => {
  setServerPort(3457);
});

afterEach(() => {
  resetServerInfo();
  cleanup();
});

describe('SettingsPage (Issue #1178 — agent management removed)', () => {
  it('does not render the agent management UI', async () => {
    await renderWithRouter(<SettingsPage />);

    expect(screen.queryByText('+ Add Agent')).toBeNull();
    expect(screen.queryByText('No agents registered')).toBeNull();
    expect(screen.queryByText('Loading agents...')).toBeNull();
  });

  it('renders a note linking to the Agents page', async () => {
    await renderWithRouter(<SettingsPage />);

    expect(screen.getByText(/Agent management has moved to the/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Agents page' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/agents');
  });

  it('still renders the McpInstallSection', async () => {
    await renderWithRouter(<SettingsPage />);

    expect(screen.getByText('Install MCP server in Claude Code')).toBeTruthy();
  });
});
