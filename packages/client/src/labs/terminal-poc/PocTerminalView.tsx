import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { PocTerminalInstance } from './poc-terminal-store';
import type { PocRow, PocSegment, PocStyle } from './buffer-to-rows';
import { PocScrollIndicator } from './PocScrollIndicator';

const FONT_FAMILY =
  "'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace";
const RESIZE_DEBOUNCE_MS = 150;
const BOTTOM_THRESHOLD_PX = 4;

interface PocTerminalViewProps {
  instance: PocTerminalInstance;
  onRequestFocus?: () => void;
}

function segmentStyle(style: PocStyle | null): CSSProperties | undefined {
  if (!style) return undefined;
  const css: CSSProperties = {};
  if (style.fg) css.color = style.fg;
  if (style.bg) css.backgroundColor = style.bg;
  if (style.bold) css.fontWeight = 'bold';
  if (style.italic) css.fontStyle = 'italic';
  if (style.dim) css.opacity = 0.6;
  if (style.underline && style.strikethrough) css.textDecoration = 'underline line-through';
  else if (style.underline) css.textDecoration = 'underline';
  else if (style.strikethrough) css.textDecoration = 'line-through';
  return css;
}

const Row = memo(function Row({ row }: { row: PocRow }) {
  return (
    <div style={{ whiteSpace: 'pre' }}>
      {row.segments.map((seg: PocSegment, i) => (
        <span key={i} style={segmentStyle(seg.style)}>
          {seg.text}
        </span>
      ))}
    </div>
  );
});

export function PocTerminalView({ instance, onRequestFocus }: PocTerminalViewProps) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const wasAtBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Read by the native wheel/touch listeners (attached once, keyed on instance)
  // so they know whether to forward scroll to the app or let native scroll run.
  const bufferTypeRef = useRef<'normal' | 'alternate'>('normal');
  bufferTypeRef.current = snapshot.bufferType;

  // Mount reference for memory management: the instance is kept alive while this
  // view is mounted and becomes idle-evictable after unmount. release() is
  // idempotent, so Strict-Mode's double invoke is safe.
  useEffect(() => {
    const release = instance.acquire();
    return release;
  }, [instance]);

  // Record whether the user is pinned to the bottom BEFORE the DOM updates, so
  // the layout effect below can decide whether to auto-scroll.
  const container = scrollRef.current;
  if (container) {
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    wasAtBottomRef.current = distance <= BOTTOM_THRESHOLD_PX;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [snapshot]);

  const [scrollTick, setScrollTick] = useState(0);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance <= BOTTOM_THRESHOLD_PX);
    setScrollTick((t) => t + 1);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  // Measure cell size + observe container size -> derive cols/rows -> resize.
  useEffect(() => {
    const el = scrollRef.current;
    const measure = measureRef.current;
    if (!el || !measure) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const applyResize = () => {
      const rect = measure.getBoundingClientRect();
      const charW = rect.width || 8;
      const charH = rect.height || 16;
      // clientWidth/Height include the container's padding; subtract it so the
      // grid is not overestimated.
      const computed = getComputedStyle(el);
      const paddingX = parseFloat(computed.paddingLeft) + parseFloat(computed.paddingRight);
      const paddingY = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom);
      const cols = Math.max(2, Math.floor((el.clientWidth - paddingX) / charW));
      const rows = Math.max(1, Math.floor((el.clientHeight - paddingY) / charH));
      instance.resize(cols, rows);
    };

    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(applyResize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);
    applyResize();

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [instance]);

  // Alternate-screen scroll forwarding. Native (non-passive) wheel + touch
  // listeners so preventDefault works; attached once per instance and gated on
  // bufferTypeRef so we do not re-subscribe on every snapshot.
  useEffect(() => {
    const el = scrollRef.current;
    const measure = measureRef.current;
    if (!el || !measure) return;

    // Fractional line remainder carried between events for smooth stepping.
    let remainder = 0;
    let touchLastY: number | null = null;

    const cellMetrics = () => {
      const r = measure.getBoundingClientRect();
      return { charW: r.width || 8, charH: r.height || 16 };
    };
    const cellFromPoint = (clientX: number, clientY: number, charW: number, charH: number) => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.floor((clientX - rect.left) / charW) + 1,
        y: Math.floor((clientY - rect.top) / charH) + 1,
      };
    };
    const stepFrom = (deltaPx: number, charH: number): number => {
      const total = remainder + deltaPx;
      const steps = Math.trunc(total / charH);
      remainder = total - steps * charH;
      return steps;
    };

    const onWheel = (e: WheelEvent) => {
      if (bufferTypeRef.current !== 'alternate') return; // main screen: native scroll
      e.preventDefault();
      const { charW, charH } = cellMetrics();
      const steps = stepFrom(e.deltaY, charH);
      if (steps === 0) return;
      instance.forwardScroll(steps, cellFromPoint(e.clientX, e.clientY, charW, charH));
    };

    const onTouchStart = (e: TouchEvent) => {
      if (bufferTypeRef.current !== 'alternate') return;
      touchLastY = e.touches[0]?.clientY ?? null;
      remainder = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (bufferTypeRef.current !== 'alternate') return;
      const touch = e.touches[0];
      if (!touch || touchLastY === null) return;
      e.preventDefault(); // suppress rubber-banding
      const { charW, charH } = cellMetrics();
      // Finger up (clientY decreases) => content scrolls toward newer (down).
      const steps = stepFrom(touchLastY - touch.clientY, charH);
      if (steps === 0) return;
      touchLastY = touch.clientY;
      instance.forwardScroll(steps, cellFromPoint(touch.clientX, touch.clientY, charW, charH));
    };
    const onTouchEnd = () => {
      touchLastY = null;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [instance]);

  return (
    <div className="relative flex-1 min-h-0">
      {/* Hidden single-cell probe for measuring monospace cell metrics. */}
      <span
        ref={measureRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          fontFamily: FONT_FAMILY,
          fontSize: 14,
          lineHeight: '18px',
          whiteSpace: 'pre',
        }}
      >
        M
      </span>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onPointerDown={onRequestFocus}
        className="h-full overflow-y-auto bg-[#1a1a2e] text-[#eeeeee] px-2 py-1"
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 14,
          lineHeight: '18px',
          overscrollBehavior: 'contain',
          fontVariantLigatures: 'none',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {snapshot.rows.map((row) => (
          <Row key={row.key} row={row} />
        ))}
      </div>

      {/* tick = scroll events + snapshot version, so the thumb appears on scroll
          and on content growth, then fades after inactivity. */}
      <PocScrollIndicator containerRef={scrollRef} tick={scrollTick + snapshot.version} />

      {!atBottom && (
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            scrollToBottom();
          }}
          className="absolute bottom-3 right-3 rounded-full bg-slate-700 hover:bg-slate-600 text-white text-xs px-3 py-2 shadow-lg"
        >
          Jump to bottom
        </button>
      )}
    </div>
  );
}
