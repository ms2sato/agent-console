import { describe, it, expect, mock, afterEach } from 'bun:test';
import { screen, cleanup } from '@testing-library/react';
import { renderWithRouter } from '../../../test/renderWithRouter';
import { MobileNavMenu } from '../MobileNavMenu';

describe('MobileNavMenu', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('should render navigation links when open', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      expect(screen.getByText('Jobs')).toBeTruthy();
      expect(screen.getByText('Agents')).toBeTruthy();
      expect(screen.getByText('Repositories')).toBeTruthy();
    });

    it('should not render when closed', async () => {
      await renderWithRouter(<MobileNavMenu open={false} onClose={() => {}} />);
      expect(screen.queryByText('Jobs')).toBeNull();
      expect(screen.queryByText('Agents')).toBeNull();
      expect(screen.queryByText('Repositories')).toBeNull();
    });

    it('should have Main navigation aria-label', async () => {
      await renderWithRouter(<MobileNavMenu open={true} onClose={() => {}} />);
      const nav = screen.getByRole('navigation');
      expect(nav.getAttribute('aria-label')).toBe('Main navigation');
    });
  });

  describe('Interactions', () => {
    it('should call onClose when Escape key is pressed', async () => {
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={true} onClose={onClose} />);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should not respond to Escape when closed', async () => {
      const onClose = mock(() => {});
      await renderWithRouter(<MobileNavMenu open={false} onClose={onClose} />);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
