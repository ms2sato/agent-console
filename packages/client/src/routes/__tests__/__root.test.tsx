/**
 * Tests for MobileHeaderControls component.
 * Tests mobile header behavior (hamburger menu, sessions button, nav menu)
 * using a props-based component to avoid mock.module() entirely.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { renderWithRouter } from '../../test/renderWithRouter';
import { MobileHeaderControls, type MobileHeaderControlsProps } from '../../components/header/MobileHeaderControls';

function defaultProps(overrides: Partial<MobileHeaderControlsProps> = {}): MobileHeaderControlsProps {
  return {
    mobileNavOpen: false,
    mobileSidebarOpen: false,
    hasAnyAsking: false,
    onOpenSidebar: mock(() => {}),
    onCloseSidebar: mock(() => {}),
    onToggleNav: mock(() => {}),
    onCloseNav: mock(() => {}),
    sidebarContent: <div>Sidebar content</div>,
    ...overrides,
  };
}

describe('MobileHeaderControls', () => {
  afterEach(() => {
    cleanup();
  });

  it('should render the sessions icon button', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps()} />);
    const sessionsButton = screen.getByLabelText('Open sessions');
    expect(sessionsButton).toBeTruthy();
  });

  it('should render the hamburger menu button', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps()} />);
    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton).toBeTruthy();
  });

  it('should show nav menu when mobileNavOpen is true', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: true })} />);
    const nav = screen.getByRole('navigation');
    expect(nav).toBeTruthy();
    expect(nav.textContent).toContain('Jobs');
    expect(nav.textContent).toContain('Agents');
    expect(nav.textContent).toContain('Repositories');
  });

  it('should call onToggleNav when hamburger button is clicked', async () => {
    const onToggleNav = mock(() => {});
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ onToggleNav })} />);
    fireEvent.click(screen.getByLabelText('Open menu'));
    expect(onToggleNav).toHaveBeenCalledTimes(1);
  });

  it('should toggle hamburger button aria-label based on mobileNavOpen', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: false })} />);
    const menuButton = screen.getByLabelText('Open menu');
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('should show Close menu label when nav is open', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileNavOpen: true })} />);
    const closeButton = screen.getByLabelText('Close menu');
    expect(closeButton).toBeTruthy();
    expect(closeButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('should call onOpenSidebar when sessions button is clicked', async () => {
    const onOpenSidebar = mock(() => {});
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ onOpenSidebar })} />);
    fireEvent.click(screen.getByLabelText('Open sessions'));
    expect(onOpenSidebar).toHaveBeenCalledTimes(1);
  });

  it('should show sidebar drawer when mobileSidebarOpen is true', async () => {
    await renderWithRouter(<MobileHeaderControls {...defaultProps({ mobileSidebarOpen: true })} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Sessions drawer');
  });
});
