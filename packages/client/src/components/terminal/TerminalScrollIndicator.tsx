import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { computeIndicatorGeometry, hasOverflow } from './scroll-indicator-math';

const FADE_OUT_DELAY_MS = 800;

interface TerminalScrollIndicatorProps {
  /** The scroll container to track. */
  containerRef: RefObject<HTMLElement | null>;
  /** Signal that recomputes geometry (scroll count + snapshot version). */
  tick: number;
}

/**
 * iOS-style fade-in scroll indicator: a thin thumb on the right edge that
 * appears while scrolling and fades out after inactivity. Reads container
 * metrics directly (never via the store) so it stays cheap and event-driven.
 */
export function TerminalScrollIndicator({ containerRef, tick }: TerminalScrollIndicatorProps) {
  const [geometry, setGeometry] = useState<{ height: number; top: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const metrics = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    if (!hasOverflow(metrics)) {
      setGeometry(null);
      return;
    }
    setGeometry(computeIndicatorGeometry(metrics));
    setVisible(true);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => setVisible(false), FADE_OUT_DELAY_MS);
  }, [containerRef, tick]);

  useEffect(() => {
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, []);

  if (!geometry) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        right: 2,
        top: geometry.top,
        height: geometry.height,
        width: 4,
        borderRadius: 9999,
        backgroundColor: 'rgba(148,163,184,0.55)',
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 200ms',
      }}
    />
  );
}
