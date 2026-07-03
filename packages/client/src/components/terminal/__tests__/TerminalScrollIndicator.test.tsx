import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import type { RefObject } from 'react';
import { TerminalScrollIndicator } from '../TerminalScrollIndicator';

// The component reads scrollTop/scrollHeight/clientHeight off the container. Those
// are read-only getters on real elements, so define them on a detached div.
function makeContainerRef(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): RefObject<HTMLElement | null> {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollTop', { value: metrics.scrollTop, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  return { current: el };
}

describe('TerminalScrollIndicator', () => {
  afterEach(cleanup);

  it('renders a visible thumb when the container overflows', () => {
    const ref = makeContainerRef({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 });
    const { container } = render(<TerminalScrollIndicator containerRef={ref} tick={1} />);

    const thumb = container.querySelector('[aria-hidden]') as HTMLElement | null;
    expect(thumb).not.toBeNull();
    expect(thumb!.style.opacity).toBe('1');
    // A non-trivial thumb height was computed from the overflow geometry.
    expect(parseFloat(thumb!.style.height)).toBeGreaterThan(0);
  });

  it('renders nothing when the container does not overflow', () => {
    const ref = makeContainerRef({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
    const { container } = render(<TerminalScrollIndicator containerRef={ref} tick={1} />);

    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });

  it('schedules an auto-hide fade timer when it becomes visible', () => {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    const ref = makeContainerRef({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 });

    render(<TerminalScrollIndicator containerRef={ref} tick={1} />);

    // FADE_OUT_DELAY_MS is 800; the indicator schedules the fade-out on show.
    const fadeCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 800);
    expect(fadeCall).toBeDefined();
    setTimeoutSpy.mockRestore();
  });
});
