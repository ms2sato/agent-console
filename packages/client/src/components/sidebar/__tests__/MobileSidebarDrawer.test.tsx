import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MobileSidebarDrawer } from '../MobileSidebarDrawer';

describe('MobileSidebarDrawer', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('should render children', () => {
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Sidebar Content</div>
        </MobileSidebarDrawer>
      );
      expect(screen.getByText('Sidebar Content')).toBeTruthy();
    });

    it('should have dialog role with correct ARIA attributes when open', () => {
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeTruthy();
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-label')).toBe('Sessions drawer');
    });

    it('should not have aria-modal when closed', () => {
      render(
        <MobileSidebarDrawer open={false} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      // Dialog element is always in DOM (for CSS transitions) but aria-modal
      // is set to undefined when closed, so the attribute should not be present
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog!.getAttribute('aria-modal')).toBeNull();
    });

    it('should apply translate-x-0 class when open', () => {
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('translate-x-0');
      expect(dialog.className).not.toContain('-translate-x-full');
    });

    it('should apply -translate-x-full class when closed', () => {
      render(
        <MobileSidebarDrawer open={false} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog!.className).toContain('-translate-x-full');
      expect(dialog!.className).not.toContain('translate-x-0');
    });
  });

  describe('Interactions', () => {
    it('should call onClose when backdrop is clicked', () => {
      const onClose = mock(() => {});
      render(
        <MobileSidebarDrawer open={true} onClose={onClose}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      // Backdrop is the element with aria-hidden="true"
      const backdrop = document.querySelector('[aria-hidden="true"]');
      expect(backdrop).toBeTruthy();
      fireEvent.click(backdrop!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose when Escape key is pressed while open', () => {
      const onClose = mock(() => {});
      render(
        <MobileSidebarDrawer open={true} onClose={onClose}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      // The component uses document.addEventListener('keydown', ...) directly,
      // so dispatch a native KeyboardEvent on the document
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should not call onClose on Escape when drawer is closed', () => {
      const onClose = mock(() => {});
      render(
        <MobileSidebarDrawer open={false} onClose={onClose}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      // Listener is not registered when open is false, so Escape should be ignored
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('should not call onClose when a non-Escape key is pressed', () => {
      const onClose = mock(() => {});
      render(
        <MobileSidebarDrawer open={true} onClose={onClose}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Body scroll prevention', () => {
    it('should set body overflow to hidden when open', () => {
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      expect(document.body.style.overflow).toBe('hidden');
    });

    it('should restore body overflow when transitioning from open to closed', () => {
      const { rerender } = render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      expect(document.body.style.overflow).toBe('hidden');

      rerender(
        <MobileSidebarDrawer open={false} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      expect(document.body.style.overflow).not.toBe('hidden');
    });

    it('should not modify body overflow when rendered as closed', () => {
      const originalOverflow = document.body.style.overflow;
      render(
        <MobileSidebarDrawer open={false} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      expect(document.body.style.overflow).toBe(originalOverflow);
    });
  });
});
