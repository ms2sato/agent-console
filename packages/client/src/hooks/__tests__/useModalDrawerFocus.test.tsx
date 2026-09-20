import { useRef, useState, type RefObject } from 'react';
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup, renderHook } from '@testing-library/react';
import { useModalDrawerFocus, getTabbables } from '../useModalDrawerFocus';
import { AccordionSectionBody } from '../../components/sessions/AccordionSectionBody';

afterEach(() => {
  cleanup();
});

function buildContainer(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('getTabbables', () => {
  it('excludes elements with tabindex="-1", even when they matched via a non-[tabindex] selector alternative', () => {
    // Reach (measured): dropping the `el.tabIndex < 0` filter in
    // useModalDrawerFocus.ts fails this test (the tabindex="-1" button is
    // then included).
    const container = buildContainer('<button>A</button><button tabindex="-1">B</button>');
    expect(getTabbables(container).map((el) => el.textContent)).toEqual(['A']);
  });

  it('excludes elements with any other negative tabindex, not only the literal "-1"', () => {
    // Reach (measured): reverting the filter to the literal
    // `el.getAttribute('tabindex') === '-1'` string check fails this test
    // (the tabindex="-2" button is then included, since "-2" !== "-1").
    // Reading `el.tabIndex` (the PROPERTY, not the raw attribute string)
    // normalises any negative/invalid tabindex value to a real negative
    // number, so this filter catches all of them, not only "-1".
    const container = buildContainer('<button>A</button><button tabindex="-2">B</button>');
    expect(getTabbables(container).map((el) => el.textContent)).toEqual(['A']);
  });

  it('excludes <input type="hidden">, even though the bare `input` selector alternative matches it', () => {
    // Reach (measured): dropping the
    // `el instanceof HTMLInputElement && el.type === 'hidden'` filter fails
    // this test (the hidden input is then included) -- it is never a tab
    // stop in any browser, and the `input` selector alternative matches it
    // regardless of `type`.
    const container = buildContainer('<button>A</button><input type="hidden" value="x" />');
    expect(getTabbables(container).map((el) => el.tagName)).toEqual(['BUTTON']);
  });

  it('excludes disabled elements', () => {
    // Reach (measured): dropping the `el.hasAttribute('disabled')` filter
    // fails this test (the disabled input is then included).
    const container = buildContainer('<button>A</button><input disabled />');
    expect(getTabbables(container).map((el) => el.tagName)).toEqual(['BUTTON']);
  });

  it('excludes descendants of an [inert] or [hidden] ancestor within the container', () => {
    // Reach (measured): dropping the ancestor walk (the `while` loop) fails
    // this test (B and C are then included).
    const container = buildContainer(
      '<button>A</button>' +
        '<div inert><button>B</button></div>' +
        '<div hidden><button>C</button></div>' +
        '<button>D</button>'
    );
    expect(getTabbables(container).map((el) => el.textContent)).toEqual(['A', 'D']);
  });

  it('excludes an element that is ITSELF [inert] or [hidden] (the subtree root, not only its ancestors)', () => {
    // Reach (measured): starting the walk at `el.parentElement` instead of
    // `el` itself fails this test (E and F are then included) -- a
    // `<button hidden>` or `<input inert>` is not tabbable in any browser,
    // and the doc comment's "is ... [inert] or [hidden]" means the subtree
    // root counts, not only its ancestors.
    const container = buildContainer(
      '<button>A</button>' + '<button hidden>E</button>' + '<button inert>F</button>' + '<button>D</button>'
    );
    expect(getTabbables(container).map((el) => el.textContent)).toEqual(['A', 'D']);
  });

  it('returns tabbables in document order', () => {
    const container = buildContainer('<a href="#">A</a><button>B</button><input aria-label="C" />');
    const result = getTabbables(container);
    expect(result.map((el) => el.tagName)).toEqual(['A', 'BUTTON', 'INPUT']);
  });

  it('returns an empty array for a container with no tabbables', () => {
    const container = buildContainer('<div>plain</div>');
    expect(getTabbables(container)).toEqual([]);
  });

  it('returns a single-element array for a container with exactly one tabbable', () => {
    const container = buildContainer('<div>plain</div><button>Only</button>');
    const result = getTabbables(container);
    expect(result.length).toBe(1);
    expect(result[0]!.textContent).toBe('Only');
  });

  it('excludes a collapsed AccordionSectionBody\'s scroller stand-in via its wrapper\'s inert attribute, includes it once expanded', () => {
    // happy-dom performs no layout and does not model Chrome's
    // keyboard-focusable-scrollers behavior, so this pin cannot exercise
    // that browser quirk directly. What it proves instead is narrower and
    // fully within reach of this hook's own logic: AccordionSectionBody's
    // wrapper carries `inert` while collapsed, and getTabbables' ancestor
    // walk (above) already excludes every descendant of an `[inert]`
    // ancestor -- so a stand-in tabbable INSIDE the collapsed body (playing
    // the role a Chrome-made-focusable overflow-y-auto scroller would play)
    // is excluded via that existing mechanism, and reappears once expanded.
    // This is the only unit-layer pin that involves the scroller concept at
    // all; it proves the hook's Tab-wrap boundary will never land on a
    // collapsed scroller, not that Chrome itself behaves this way -- that
    // is what the Browser QA captures attached to the PR verify instead.
    const { container, rerender } = render(
      <div>
        <button>outside</button>
        <AccordionSectionBody isExpanded={false}>
          <div tabIndex={0}>scroller</div>
        </AccordionSectionBody>
      </div>
    );

    expect(getTabbables(container).map((el) => el.textContent)).toEqual(['outside']);

    rerender(
      <div>
        <button>outside</button>
        <AccordionSectionBody isExpanded={true}>
          <div tabIndex={0}>scroller</div>
        </AccordionSectionBody>
      </div>
    );

    expect(getTabbables(container).map((el) => el.textContent)).toEqual(['outside', 'scroller']);
  });
});

function FocusHarness({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { containerProps } = useModalDrawerFocus({ open, onClose, containerRef });
  return (
    <div ref={containerRef} data-testid="container" {...containerProps}>
      {children}
    </div>
  );
}

/**
 * Two independent `useModalDrawerFocus` instances, each with its own
 * `open` state and its own container -- models the real shape of
 * `MobileSidebarDrawer` (mounted from `routes/__root.tsx`) and
 * `SessionSidePanelsDrawer` (mounted from `SessionPage.tsx`), which can
 * legitimately both be open at the same time on a narrow viewport.
 */
function TwoInstanceScrollLockHarness() {
  const [openA, setOpenA] = useState(false);
  const [openB, setOpenB] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpenA((v) => !v)}>
        toggle-a
      </button>
      <button type="button" onClick={() => setOpenB((v) => !v)}>
        toggle-b
      </button>
      <FocusHarness open={openA} onClose={() => setOpenA(false)}>
        <button type="button">A</button>
      </FocusHarness>
      <FocusHarness open={openB} onClose={() => setOpenB(false)}>
        <button type="button">B</button>
      </FocusHarness>
    </>
  );
}

function ToggleHarness({ removableTrigger = false }: { removableTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [showTrigger, setShowTrigger] = useState(true);
  return (
    <>
      {showTrigger && (
        <button type="button" onClick={() => setOpen(true)}>
          trigger
        </button>
      )}
      {removableTrigger && (
        <button type="button" onClick={() => setShowTrigger(false)}>
          remove-trigger
        </button>
      )}
      <FocusHarness open={open} onClose={() => setOpen(false)}>
        <button type="button" onClick={() => setOpen(false)}>
          A
        </button>
      </FocusHarness>
    </>
  );
}

describe('useModalDrawerFocus', () => {
  it('focuses the first tabbable element when opened', () => {
    // Reach (measured): removing the `?? container` fallback does not
    // affect this test, under either mutation shape -- `first!.focus()`
    // (asserting non-null) or the realistic `first?.focus()` (a no-op
    // when there is nothing to focus). A tabbable exists here, so `first`
    // is always defined and the fallback is never reached either way; the
    // fallback's own reach is covered by the MobileSidebarDrawer.test.tsx
    // "no focusable children" pin instead.
    render(
      <FocusHarness open={true} onClose={() => {}}>
        <button type="button">A</button>
        <button type="button">B</button>
      </FocusHarness>
    );
    expect(document.activeElement).toBe(screen.getByText('A'));
  });

  it('restores focus to the previously focused trigger on close', () => {
    // Reach (measured): removing the closed-branch restore call (the
    // `if (saved instanceof HTMLElement && saved.isConnected) saved.focus();`
    // branch) fails this test -- focus stays on 'A' instead of returning to
    // the trigger.
    render(<ToggleHarness />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByText('A'));

    fireEvent.click(screen.getByText('A'));
    expect(document.activeElement).toBe(trigger);
  });

  it('does not call .focus() on a saved element that was removed from the DOM before close', () => {
    // Reach (measured): removing the `saved.isConnected` check (keeping only
    // `saved instanceof HTMLElement`) fails this test -- the mock is then
    // called once even though the element is disconnected. Calling .focus()
    // on a disconnected element does not throw and does not move
    // `document.activeElement` in happy-dom, so a "no throw" / "focus
    // unchanged" assertion alone has zero reach here; the mock is what
    // actually observes the guard.
    //
    // An own-property mock is used here instead of `spyOn(trigger, 'focus')`
    // because, in the FULL client test process (not this file in isolation),
    // an earlier test file leaves `HTMLElement.prototype.focus` as an
    // accessor property, and bun:test's `spyOn` does not support spying on
    // accessor properties -- making a `spyOn`-based version of this test
    // order-dependent on which other test files ran first in the process.
    // Defining `focus` directly as an own data property on `trigger` never
    // touches the prototype, so it is unaffected by that.
    render(<ToggleHarness removableTrigger />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByText('A'));

    const focusMock = mock(() => {});
    Object.defineProperty(trigger, 'focus', { value: focusMock, configurable: true, writable: true });
    fireEvent.click(screen.getByText('remove-trigger'));
    expect(trigger.isConnected).toBe(false);

    expect(() => {
      fireEvent.click(screen.getByText('A'));
    }).not.toThrow();
    expect(focusMock).not.toHaveBeenCalled();
  });

  it('returns the closed and open containerProps shapes', () => {
    // Reach (measured): removing `inert` from the returned containerProps
    // object (e.g. hardcoding it to `undefined` always) fails the closed
    // assertion below.
    const containerRef: RefObject<HTMLElement> = { current: null };
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useModalDrawerFocus({ open, onClose: () => {}, containerRef }),
      { initialProps: { open: false } }
    );
    expect(result.current.containerProps).toEqual({
      tabIndex: -1,
      inert: '',
      'aria-hidden': true,
      'aria-modal': undefined,
    });

    rerender({ open: true });
    expect(result.current.containerProps).toEqual({
      tabIndex: -1,
      inert: undefined,
      'aria-hidden': false,
      'aria-modal': true,
    });
  });

  it('reference-counts the body scroll lock across two simultaneously open instances (e.g. both mobile drawers open at once)', () => {
    // Reach (measured): reverting the scroll-lock effect to a per-instance
    // snapshot/restore (each effect capturing its own `original` on open
    // and restoring THAT value on close, instead of the shared
    // `scrollLockCount` / `scrollLockOriginalOverflow` module-level pair)
    // fails this test at the "closing A while B is still open" assertion
    // below: A's own effect restores the ORIGINAL (pre-open) overflow even
    // though B is still open, unlocking the scroll early.
    const originalOverflow = document.body.style.overflow;
    render(<TwoInstanceScrollLockHarness />);
    expect(document.body.style.overflow).toBe(originalOverflow);

    fireEvent.click(screen.getByText('toggle-a'));
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByText('toggle-b'));
    expect(document.body.style.overflow).toBe('hidden');

    // Close the FIRST-opened instance while the second is still open: the
    // lock must stay applied (this is the assertion the reverted mutation
    // fails).
    fireEvent.click(screen.getByText('toggle-a'));
    expect(document.body.style.overflow).toBe('hidden');

    // Close the second (now the only remaining open) instance: the lock
    // releases, restoring the pre-open value.
    fireEvent.click(screen.getByText('toggle-b'));
    expect(document.body.style.overflow).toBe(originalOverflow);
  });
});
