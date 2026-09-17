import { useEffect, useRef, type RefObject } from 'react';

/**
 * Returns the tabbable descendants of `container`, in document order.
 *
 * Selects every element that could be a tab stop (`a[href]`, `button`,
 * `input`, `select`, `textarea`, `[tabindex]`) and then filters out
 * anything that is actually excluded from the tab order:
 *   - `tabindex="-1"`, checked as a POST-selection filter rather than
 *     folded into the selector. `button, [href], input, select, textarea,
 *     [tabindex]:not([tabindex="-1"])` looks equivalent but is not: a
 *     `<button tabindex="-1">` still matches the bare `button` alternative
 *     in that selector list, so the `:not([tabindex="-1"])` clause (only
 *     attached to the `[tabindex]` alternative) never runs against it. A
 *     filter applied after selection is the only construction that
 *     excludes an element regardless of which alternative matched it.
 *   - `disabled`.
 *   - any element that is, or has an ancestor (walking up to but
 *     excluding `container` itself) that is, `[inert]` or `[hidden]`.
 *     The walk stops at `container` on purpose: callers make the
 *     container itself inert while closed, and including it in the walk
 *     would make every call after close-time report nothing was ever
 *     tabbable inside it.
 *
 * Deliberately no visibility/geometry check (`getComputedStyle`,
 * `offsetParent`, `getClientRects`): happy-dom performs no layout, so a
 * geometry-based filter would silently treat every element as invisible
 * in the unit test layer. The hidden/inert ancestor walk above is the
 * structural substitute this codebase can actually verify without a real
 * browser.
 */
export function getTabbables(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
  );
  return candidates.filter((el) => {
    if (el.getAttribute('tabindex') === '-1') return false;
    if (el.hasAttribute('disabled')) return false;
    // Starts at `el` itself, not its parent: `<button hidden>` or
    // `<input inert>` is not tabbable in any browser, and "is ... [inert]
    // or [hidden]" (the doc comment above) means the subtree ROOT counts,
    // not only its ancestors.
    let node: HTMLElement | null = el;
    while (node && node !== container) {
      if (node.hasAttribute('inert') || node.hasAttribute('hidden')) return false;
      node = node.parentElement;
    }
    return true;
  });
}

interface UseModalDrawerFocusParams {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement>;
}

interface ModalDrawerFocusContainerProps {
  tabIndex: -1;
  inert: '' | undefined;
  'aria-hidden': boolean;
  'aria-modal': true | undefined;
}

interface UseModalDrawerFocusReturn {
  containerProps: ModalDrawerFocusContainerProps;
}

/**
 * Single writer of the focus-boundary contract for the mobile modal
 * drawers (`MobileSidebarDrawer`, `SessionSidePanelsDrawer`). Both stay
 * mounted while closed (for CSS transitions), so "closed" has to be
 * enforced as a real focus/tab boundary, not merely a visual one.
 *
 * Owns four independent effects, always in this order:
 *   1. Escape-to-close, listening on `document` rather than the
 *      container. While the drawer is open, focus may rest on the
 *      backdrop-covered page body -- there is no focus-trapping backdrop
 *      element -- so a container-level listener would miss Escape
 *      presses that happen before focus ever enters the container.
 *   2. Body scroll lock while open.
 *   3. Focus save / initial focus / restore: saves the previously
 *      focused element on open, focuses the first tabbable descendant of
 *      the container (or the container itself, via `containerProps`'s
 *      `tabIndex: -1`, when there is none), and restores the saved
 *      element on close.
 *   4. Tab trap, listening ON THE CONTAINER, never `document`: this is
 *      also what makes the trap inert by construction while closed --
 *      the container carries `inert` then, so no listener needs to check
 *      `open` at call time to know it must do nothing. Wraps Tab at the
 *      last tabbable back to the first, and Shift+Tab at the first back
 *      to the last.
 */
export function useModalDrawerFocus({
  open,
  onClose,
  containerRef,
}: UseModalDrawerFocusParams): UseModalDrawerFocusReturn {
  const savedFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      savedFocusRef.current = document.activeElement;
      const container = containerRef.current;
      if (!container) return;
      const first = getTabbables(container)[0];
      (first ?? container).focus();
    } else {
      const saved = savedFocusRef.current;
      savedFocusRef.current = null;
      if (saved instanceof HTMLElement && saved.isConnected) {
        saved.focus();
      }
    }
    // `containerRef` is a stable ref object across renders -- this effect
    // must only re-run when `open` changes, never when the drawer's
    // children change (e.g. a pending query resolving and rendering a
    // section header for the first time). Re-running on every render
    // would steal focus back to the first tabbable while the drawer is
    // already open and a keyboard user has since moved focus elsewhere
    // inside it.
  }, [open, containerRef]);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const tabbables = getTabbables(container);
      if (tabbables.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? tabbables.indexOf(active) : -1;
      const first = tabbables[0]!;
      const last = tabbables[tabbables.length - 1]!;
      if (e.shiftKey) {
        // active === first, or active is not inside the tabbables list at
        // all (e.g. the container itself, from the initial fallback focus).
        if (activeIndex <= 0) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeIndex === -1 || activeIndex === tabbables.length - 1) {
        e.preventDefault();
        first.focus();
      }
      // otherwise let the browser move focus sequentially
    };
    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [open, containerRef]);

  return {
    containerProps: {
      tabIndex: -1,
      inert: open ? undefined : '',
      'aria-hidden': !open,
      'aria-modal': open || undefined,
    },
  };
}
