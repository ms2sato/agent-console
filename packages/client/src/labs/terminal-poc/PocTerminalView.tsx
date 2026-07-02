import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, ReactNode } from 'react';
import type { PocTerminalInstance } from './poc-terminal-store';
import type { PocRow, PocSegment, PocStyle } from './buffer-to-rows';
import type { LinkRange } from './link-detection';
import { joinSelectedRows, collectSelectedRowPieces } from './copy-text';
import { reduceDragCounter } from './drag-state';
import { PocScrollIndicator } from './PocScrollIndicator';

const FONT_FAMILY =
  "'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace";
const FONT_SIZE_PX = 14;
// Fixed per-row height. Every row div is pinned to this so blank rows still
// occupy one cell (an empty span collapses to 0), keeping the DOM row grid a
// 1:1 pixel map of the buffer — required for correct pointer->cell math.
const LINE_HEIGHT_PX = 18;
const RESIZE_DEBOUNCE_MS = 150;
const BOTTOM_THRESHOLD_PX = 4;
// A touch pointer that moves more than this between down and up is a scroll
// gesture (forwarded as wheel), not a tap — do not report it as a TUI click.
const CLICK_MOVE_THRESHOLD_PX = 5;

interface PocTerminalViewProps {
  instance: PocTerminalInstance;
  onRequestFocus?: () => void;
  // Called when files are dropped onto the terminal. Threaded to the same
  // handler as image paste; the labs route surfaces a toast.
  onFilesReceived?: (files: File[]) => void;
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

// Split a segment's text at link boundaries. `segStart` is the segment's offset
// into the row's concatenated text; `links` are ranges in that same space.
function renderSegment(seg: PocSegment, segStart: number, key: number, links: LinkRange[]) {
  const style = segmentStyle(seg.style);
  const segEnd = segStart + seg.text.length;
  const overlapping = links.filter((l) => l.start < segEnd && l.end > segStart);
  if (overlapping.length === 0) {
    return (
      <span key={key} style={style}>
        {seg.text}
      </span>
    );
  }
  // Walk the segment, emitting plain spans and <a> for the link portions.
  const parts: ReactNode[] = [];
  let cursor = segStart;
  let pi = 0;
  for (const link of overlapping) {
    const linkStart = Math.max(link.start, segStart);
    const linkEnd = Math.min(link.end, segEnd);
    if (cursor < linkStart) {
      parts.push(
        <span key={pi++} style={style}>
          {seg.text.slice(cursor - segStart, linkStart - segStart)}
        </span>,
      );
    }
    parts.push(
      <a
        key={pi++}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        // Link click opens the URL; stop propagation so the container's
        // click-to-focus / mouse-report paths do not also fire. No
        // preventDefault so navigation happens.
        onClick={(e) => e.stopPropagation()}
        style={{ ...style, textDecoration: 'underline dotted', cursor: 'pointer' }}
      >
        {seg.text.slice(linkStart - segStart, linkEnd - segStart)}
      </a>,
    );
    cursor = linkEnd;
  }
  if (cursor < segEnd) {
    parts.push(
      <span key={pi++} style={style}>
        {seg.text.slice(cursor - segStart)}
      </span>,
    );
  }
  return (
    <span key={key} style={style}>
      {parts}
    </span>
  );
}

const Row = memo(function Row({ row }: { row: PocRow }) {
  let offset = 0;
  return (
    <div style={{ whiteSpace: 'pre', height: LINE_HEIGHT_PX, lineHeight: `${LINE_HEIGHT_PX}px` }}>
      {row.segments.map((seg: PocSegment, i) => {
        const node = renderSegment(seg, offset, i, row.links);
        offset += seg.text.length;
        return node;
      })}
    </div>
  );
});

export function PocTerminalView({ instance, onRequestFocus, onFilesReceived }: PocTerminalViewProps) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const wasAtBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Drag-and-drop file upload. The depth counter (drag-state.ts) nets out the
  // enter/leave events that bubble from child rows so the overlay does not
  // flicker while dragging across cells.
  const dragCounterRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const applyDragAction = (action: 'enter' | 'leave' | 'drop') => {
    const next = reduceDragCounter(dragCounterRef.current, action);
    dragCounterRef.current = next.count;
    setIsDragOver(next.isDragOver);
  };
  const onDragEnter = (e: ReactDragEvent) => {
    e.preventDefault();
    applyDragAction('enter');
  };
  // preventDefault on dragover is mandatory for the drop event to fire.
  const onDragOver = (e: ReactDragEvent) => {
    e.preventDefault();
  };
  const onDragLeave = (e: ReactDragEvent) => {
    e.preventDefault();
    applyDragAction('leave');
  };
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    applyDragAction('drop');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    onFilesReceived?.(Array.from(files));
  };

  // Read by the native wheel/touch listeners (attached once, keyed on instance)
  // so they know whether to forward scroll to the app or let native scroll run.
  const bufferTypeRef = useRef<'normal' | 'alternate'>('normal');
  bufferTypeRef.current = snapshot.bufferType;
  const mouseTrackingRef = useRef(false);
  mouseTrackingRef.current = snapshot.mouseTracking;

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

    // Container padding is static (Tailwind px-2 py-1); read once.
    const computedPadding = getComputedStyle(el);
    const paddingLeft = parseFloat(computedPadding.paddingLeft) || 0;
    const paddingTop = parseFloat(computedPadding.paddingTop) || 0;

    const cellMetrics = () => {
      const r = measure.getBoundingClientRect();
      return { charW: r.width || 8, charH: r.height || 16 };
    };
    // 1-based cell coords. Row height is fixed at LINE_HEIGHT_PX (fixed row divs)
    // so y maps exactly; add scrollTop (normal-buffer scrollback) and subtract
    // padding. x uses the measured monospace cell width.
    const cellFromPoint = (clientX: number, clientY: number, charW: number) => {
      const rect = el.getBoundingClientRect();
      const x = Math.floor((clientX - rect.left - paddingLeft) / charW) + 1;
      const y = Math.floor((clientY - rect.top - paddingTop + el.scrollTop) / LINE_HEIGHT_PX) + 1;
      return { x: Math.max(1, x), y: Math.max(1, y) };
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
      instance.forwardScroll(steps, cellFromPoint(e.clientX, e.clientY, charW));
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
      instance.forwardScroll(steps, cellFromPoint(touch.clientX, touch.clientY, charW));
    };
    const onTouchEnd = () => {
      touchLastY = null;
    };

    // --- Mouse button reporting to the TUI (focus parity) ---
    // We never preventDefault here, so click-to-focus and native selection keep
    // working. Under mouse tracking a mouse press+release reaches the TUI as a
    // click at that cell; a mouse drag reports press(down)+release(up) and the
    // TUI (e.g. Claude Code) paints its own in-TUI selection — that is expected
    // parity behavior (#943). Browser text selection is the Shift path (Shift
    // held -> we do not report, xterm convention). Right-click is never reported
    // (browser context menu wins). Touch defers to pointerup and only reports a
    // tap (movement <= threshold) so a scroll drag is not a phantom click.
    let mousePressActive = false; // a mouse press was emitted, awaiting release
    let mousePressCell: { x: number; y: number } | null = null; // cell of that press
    let touchDownX = 0;
    let touchDownY = 0;
    let touchDownCell: { x: number; y: number } | null = null;

    const reportable = (e: PointerEvent): boolean =>
      mouseTrackingRef.current && e.button === 0 && e.isPrimary && !e.shiftKey;

    const onPointerDown = (e: PointerEvent) => {
      if (!reportable(e)) return;
      // A press on a link should open it, not report a mouse click to the TUI.
      if ((e.target as Element | null)?.closest?.('a')) return;
      const { charW } = cellMetrics();
      const cell = cellFromPoint(e.clientX, e.clientY, charW);
      if (e.pointerType === 'touch') {
        touchDownX = e.clientX;
        touchDownY = e.clientY;
        touchDownCell = cell;
        mousePressActive = false;
      } else {
        instance.reportMouseButton('press', cell);
        mousePressActive = true;
        mousePressCell = cell;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return; // left-button release only
      const { charW } = cellMetrics();
      const cell = cellFromPoint(e.clientX, e.clientY, charW);
      if (e.pointerType === 'touch') {
        if (touchDownCell && mouseTrackingRef.current && !e.shiftKey) {
          const moved = Math.hypot(e.clientX - touchDownX, e.clientY - touchDownY);
          if (moved <= CLICK_MOVE_THRESHOLD_PX) {
            instance.reportMouseButton('press', touchDownCell);
            instance.reportMouseButton('release', cell);
          }
        }
        touchDownCell = null;
      } else if (mousePressActive) {
        // Release inside the container: report at the exact current cell.
        instance.reportMouseButton('release', cell);
        mousePressActive = false;
        mousePressCell = null;
      }
    };

    const onPointerCancel = () => {
      touchDownCell = null; // touch gesture aborted; mouse cancel handled on window
    };

    // Emit the release at the last press cell when the pointer is released (or
    // cancelled) OUTSIDE the container, so a mouse press never goes unpaired and
    // leaves the TUI in a dragging state. For an in-container up, the container
    // handler above runs first (bubble order) and clears the flag, so this
    // guard makes the window path a no-op — no double emission. No
    // setPointerCapture (it would re-route events and disturb native selection).
    const releaseDangling = () => {
      if (!mousePressActive || !mousePressCell) return;
      instance.reportMouseButton('release', mousePressCell);
      mousePressActive = false;
      mousePressCell = null;
    };
    const onWindowPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      releaseDangling();
    };

    // Cmd/Ctrl+A while the hidden terminal input is focused selects the TERMINAL
    // content only (scrollback + viewport = the whole rows container), not the
    // page. Gated on activeElement being a textarea (our hidden input) so we do
    // not hijack select-all elsewhere.
    const onKeyDownSelectAll = (e: KeyboardEvent) => {
      if (e.key !== 'a' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (!(document.activeElement instanceof HTMLTextAreaElement)) return;
      const sel = window.getSelection();
      if (!sel) return;
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    };

    // Soft-wrap-aware copy: terminals join wrapped rows into one logical line on
    // copy (a wrapped URL pastes as one line). We rebuild the clipboard text from
    // each selected row's exact selected text (so partial first/last-row edges
    // are preserved) joined per the snapshot's isWrapped flags. Single-row
    // selections keep the native behavior (already correct).
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const selRange = sel.getRangeAt(0);
      if (!el.contains(selRange.commonAncestorContainer)) return; // selection outside terminal
      const snapshotRows = instance.getSnapshot().rows;
      const pieces = collectSelectedRowPieces(
        el,
        selRange,
        (i) => snapshotRows[i]?.isWrapped ?? false,
      );
      if (pieces.length < 2) return; // single row: native copy is already correct
      e.clipboardData?.setData('text/plain', joinSelectedRows(pieces));
      e.preventDefault();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('copy', onCopy);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', releaseDangling);
    window.addEventListener('keydown', onKeyDownSelectAll);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('copy', onCopy);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', releaseDangling);
      window.removeEventListener('keydown', onKeyDownSelectAll);
      // Unmount mid-drag: pair the outstanding press so the TUI is not stuck.
      releaseDangling();
    };
  }, [instance]);

  return (
    <div
      className="relative flex-1 min-h-0"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag-over overlay for file drop (mirrors production Terminal.tsx). */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-blue-400 bg-blue-500/20 pointer-events-none">
          <span className="text-lg font-medium text-blue-300">Drop file here</span>
        </div>
      )}

      {/* Hidden single-cell probe for measuring monospace cell metrics. */}
      <span
        ref={measureRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          fontFamily: FONT_FAMILY,
          fontSize: FONT_SIZE_PX,
          lineHeight: `${LINE_HEIGHT_PX}px`,
          whiteSpace: 'pre',
        }}
      >
        M
      </span>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        // Focus on click (not pointerdown): click fires after the browser's
        // default mousedown focus handling, so our focus() sticks. pointerdown
        // focus is immediately undone by the default handler (focus -> BODY).
        // Skip when a text selection was just made so native drag-select works.
        onClick={() => {
          if (window.getSelection()?.toString()) return;
          onRequestFocus?.();
        }}
        className="h-full overflow-y-auto bg-[#1a1a2e] text-[#eeeeee] px-2 py-1"
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: FONT_SIZE_PX,
          lineHeight: `${LINE_HEIGHT_PX}px`,
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
