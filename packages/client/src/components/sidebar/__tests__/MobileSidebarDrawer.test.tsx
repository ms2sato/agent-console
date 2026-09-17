import { useState } from 'react';
import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    it('should make the drawer wrapper a bounded-height flex container so children can be stretched to fill it (Issue #1170)', () => {
      // The drawer wrapper is `h-full` but must also establish a flex
      // column context so its child (the sidebar `<aside>`) is stretched to
      // fill the drawer's bounded height. Without `flex flex-col`, the
      // aside grows with its content on mobile and long session lists get
      // cut off with no way to scroll to the overflow.
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      const dialog = screen.getByRole('dialog');
      const classList = dialog.className.split(' ');
      expect(classList).toContain('flex');
      expect(classList).toContain('flex-col');
      expect(classList).toContain('h-full');
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
      // The hook (useModalDrawerFocus) registers a document-level keydown
      // listener, so dispatch a native KeyboardEvent on the document
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
    let originalOverflow: string;
    beforeEach(() => {
      originalOverflow = document.body.style.overflow;
    });
    afterEach(() => {
      document.body.style.overflow = originalOverflow;
    });

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

  describe('Focus boundary', () => {
    function ABCChildren() {
      return (
        <>
          <button type="button">A</button>
          <button type="button">B</button>
          <button type="button">C</button>
        </>
      );
    }

    function TriggerHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open-trigger
          </button>
          <MobileSidebarDrawer open={open} onClose={() => setOpen(false)}>
            <button type="button" onClick={() => setOpen(false)}>
              close-me
            </button>
          </MobileSidebarDrawer>
        </>
      );
    }

    it('focuses the first tabbable child when opened', () => {
      // Reach (measured): removing the `?? container` fallback (calling
      // `first!.focus()` unconditionally) does not affect this test (a
      // tabbable exists here) -- reach for the fallback itself is the
      // "no focusable children" pin below.
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <ABCChildren />
        </MobileSidebarDrawer>
      );
      expect(document.activeElement).toBe(screen.getByText('A'));
    });

    it('wraps Tab from the last tabbable back to the first', async () => {
      // Reach (measured): removing the non-shift Tab boundary branch
      // (`activeIndex === -1 || activeIndex === tabbables.length - 1`)
      // fails this test -- user-event moves focus to document.body instead
      // (per its own "wraps at the document level" behaviour), not back to A.
      const user = userEvent.setup();
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <ABCChildren />
        </MobileSidebarDrawer>
      );
      act(() => {
        screen.getByText('C').focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(screen.getByText('A'));
    });

    it('wraps Shift+Tab from the first tabbable back to the last', async () => {
      // Reach (measured): removing the Shift+Tab boundary branch
      // (`if (activeIndex <= 0) { ... }`) fails this test.
      const user = userEvent.setup();
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <ABCChildren />
        </MobileSidebarDrawer>
      );
      act(() => {
        screen.getByText('A').focus();
      });
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(screen.getByText('C'));
    });

    it('moves focus to the first tabbable when Tab is pressed from the container itself', async () => {
      // Reach (measured): removing the ENTIRE non-shift boundary branch
      // (see "wraps Tab from the last tabbable back to the first" above)
      // does NOT fail this specific test. In this component the container
      // directly wraps A/B/C with nothing tabbable preceding A, so ordinary
      // DOM Tab traversal already lands on A when starting from the
      // container -- the same result our own boundary handling produces.
      // The narrower `activeIndex === -1` sub-clause therefore has no
      // measured reach through this scenario; kept as a behavioral pin
      // (it documents the real, correct outcome), with genuine reach for
      // the container-as-starting-point case covered by the Shift+Tab
      // variant below instead (shift+tab out of a container moves
      // BACKWARD past it in document order, which is NOT where the last
      // tabbable is, so the `activeIndex <= 0` branch -- which subsumes
      // -1 -- is what a fresh reader should trust for this case).
      const user = userEvent.setup();
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <ABCChildren />
        </MobileSidebarDrawer>
      );
      const dialog = screen.getByRole('dialog');
      act(() => {
        dialog.focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(screen.getByText('A'));
    });

    it('moves focus to the last tabbable when Shift+Tab is pressed from the container itself', async () => {
      // Reach (measured): changing the shift-path boundary check from
      // `activeIndex <= 0` to `activeIndex === 0` (dropping the -1 case)
      // fails this test. Unlike the forward-Tab case above, ordinary DOM
      // traversal does NOT coincidentally produce the same result here:
      // Shift+Tab from the container moves backward past it in document
      // order (out of the drawer entirely, wrapping at the document level
      // per user-event's own behaviour), not to C -- so this test has real
      // reach against the `<= 0` boundary that the forward-Tab test above
      // does not.
      const user = userEvent.setup();
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <ABCChildren />
        </MobileSidebarDrawer>
      );
      const dialog = screen.getByRole('dialog');
      act(() => {
        dialog.focus();
      });
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(screen.getByText('C'));
    });

    it('focuses the container itself when there are no focusable children', () => {
      // Reach (measured): removing the `?? container` fallback fails this
      // test under both the unrealistic and the realistic mutation shape.
      // `first!.focus()` (asserting non-null where `first` is actually
      // `undefined`) fails this test -- and 10 other tests in this file --
      // with an uncaught runtime TypeError propagating out of React's
      // passive effect flush. `first?.focus()` (the realistic pre-change
      // form -- a no-op when there is nothing to focus, leaving focus
      // wherever it already was) also fails this test on its own, cleanly:
      // `document.activeElement` stays at whatever the test environment's
      // default is instead of moving to the dialog.
      render(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>plain</div>
        </MobileSidebarDrawer>
      );
      expect(document.activeElement).toBe(screen.getByRole('dialog'));
    });

    it('is inert while closed and not inert while open', () => {
      // Reach (measured): removing `inert` from the hook's containerProps
      // (hardcoding it to `undefined` always) fails the closed assertion.
      //
      // DOM-level only: happy-dom reflects `inert` as a plain attribute
      // with no focus-navigation semantics, and user-event 14.6.1 ignores
      // `inert` entirely (it only honours negative tabindex and
      // `disabled`), so this pin cannot observe Tab actually skipping a
      // closed drawer's content. The behavioural half of this contract is
      // verified via Browser QA capture on the PR, not here.
      const { rerender } = render(
        <MobileSidebarDrawer open={false} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      // getByRole excludes aria-hidden elements from the accessibility
      // tree by default, so the closed dialog (aria-hidden="true") has to
      // be located with a plain selector, same as the pre-existing
      // "should not have aria-modal when closed" test above.
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog!.hasAttribute('inert')).toBe(true);
      expect(dialog!.getAttribute('inert')).toBe('');
      expect(dialog!.getAttribute('aria-hidden')).toBe('true');

      rerender(
        <MobileSidebarDrawer open={true} onClose={() => {}}>
          <div>Content</div>
        </MobileSidebarDrawer>
      );
      expect(dialog!.hasAttribute('inert')).toBe(false);
      expect(dialog!.getAttribute('aria-hidden')).toBe('false');
    });

    it('restores focus to the trigger after open then close', () => {
      // Reach (measured): removing the closed-branch restore call in the
      // hook fails this test -- focus stays on 'close-me' instead of
      // returning to 'open-trigger'.
      render(<TriggerHarness />);
      const trigger = screen.getByText('open-trigger');
      act(() => {
        trigger.focus();
      });
      fireEvent.click(trigger);
      expect(document.activeElement).toBe(screen.getByText('close-me'));

      fireEvent.click(screen.getByText('close-me'));
      expect(document.activeElement).toBe(trigger);
    });
  });
});
