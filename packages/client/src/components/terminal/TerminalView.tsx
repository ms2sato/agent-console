import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, ReactNode, RefObject } from 'react';
import type { TerminalInstance } from './terminal-store';
import type { TerminalRow, TerminalSegment, TerminalStyle } from './buffer-to-rows';
import type { LinkRange } from './link-detection';
import { joinSelectedRows, collectSelectedRowPieces } from './copy-text';
import { reduceDragCounter } from './drag-state';
import {
  applySegmentDecorators,
  applyLinkTransforms,
  type SegmentDecorator,
  type LinkTransform,
  type TransformContext,
} from './row-transforms';
import { TerminalScrollIndicator } from './TerminalScrollIndicator';

const EMPTY_DECORATORS: readonly SegmentDecorator[] = [];
const EMPTY_LINK_TRANSFORMS: readonly LinkTransform[] = [];
const DEFAULT_TRANSFORM_CONTEXT: TransformContext = { repoFullName: null };
// A dotted underline distinguishes decorator links (e.g. GitHub refs) without
// the heavier solid underline; matches the URL-link affordance.
const LINK_STYLE: CSSProperties = { textDecoration: 'underline dotted', cursor: 'pointer' };

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

interface TerminalViewProps {
  instance: TerminalInstance;
  onRequestFocus?: () => void;
  // Called when files are dropped onto the terminal. Threaded to the same
  // handler as image paste; the labs route surfaces a toast.
  onFilesReceived?: (files: File[]) => void;
  // This view's OWN hidden input (the same ref passed to TerminalKeyboardInput).
  // Cmd/Ctrl+A select-all is gated on this element being focused, so on a page
  // hosting multiple terminals, select-all in one terminal never selects
  // another's rows. When omitted, select-all is disabled (safer than matching
  // any focused textarea).
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  // Presentation-layer row-transform decorators (issue #958) applied per row at
  // render time, plus their context. Callers memoize both so the memoized Row
  // is not invalidated every render.
  segmentDecorators?: readonly SegmentDecorator[];
  // Presentation-layer link transforms applied to each row's detected URL links
  // (parallel to segmentDecorators). Used e.g. to rewrite a localhost href to
  // the user-accessible host for remote browsers. Callers memoize the list.
  linkTransforms?: readonly LinkTransform[];
  transformContext?: TransformContext;
}

function segmentStyle(style: TerminalStyle | null): CSSProperties | undefined {
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
function renderSegment(seg: TerminalSegment, segStart: number, key: number, links: LinkRange[]) {
  const style = segmentStyle(seg.style);
  // A decorator-attached link (issue #958) renders the whole segment as one
  // anchor. stopPropagation keeps the container's click-to-focus / mouse-report
  // paths from swallowing the click; no preventDefault so navigation happens.
  if (seg.link) {
    return (
      <a
        key={key}
        href={seg.link.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ ...style, ...LINK_STYLE }}
      >
        {seg.text}
      </a>
    );
  }
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
        // Set by a link transform (e.g. localhost rewrite) to explain the href
        // substitution on hover; undefined when the href was not rewritten.
        title={link.title}
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

const Row = memo(function Row({
  row,
  decorators,
  linkTransforms,
  ctx,
}: {
  row: TerminalRow;
  decorators: readonly SegmentDecorator[];
  linkTransforms: readonly LinkTransform[];
  ctx: TransformContext;
}) {
  // Decorators split segments but preserve the row's concatenated text, so the
  // URL `links` column offsets used by renderSegment stay aligned.
  const segments =
    decorators.length > 0 ? applySegmentDecorators(row.segments, decorators, ctx) : row.segments;
  // Link transforms only change href/title, never the ranges, so the column
  // offsets used by renderSegment stay aligned with the (unchanged) row text.
  const links =
    linkTransforms.length > 0 ? applyLinkTransforms(row.links, linkTransforms, ctx) : row.links;
  let offset = 0;
  return (
    <div style={{ whiteSpace: 'pre', height: LINE_HEIGHT_PX, lineHeight: `${LINE_HEIGHT_PX}px` }}>
      {segments.map((seg: TerminalSegment, i) => {
        const node = renderSegment(seg, offset, i, links);
        offset += seg.text.length;
        return node;
      })}
    </div>
  );
});

export function TerminalView({
  instance,
  onRequestFocus,
  onFilesReceived,
  inputRef,
  segmentDecorators = EMPTY_DECORATORS,
  linkTransforms = EMPTY_LINK_TRANSFORMS,
  transformContext = DEFAULT_TRANSFORM_CONTEXT,
}: TerminalViewProps) {
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const wasAtBottomRef = useRef(true);
  // Pre-commit scrollTop, captured every render before the DOM updates. The
  // anchor effect uses it as its compensation base so a browser shrink-clamp
  // (which mutates el.scrollTop before layout effects run) cannot corrupt it.
  const preCommitScrollTopRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  // Marks a scrollTop write the component itself performed (anchor compensation,
  // bottom-follow, jump-to-bottom). The scroll event it fires must NOT run the
  // §6.4 eviction check: eviction is for a user who genuinely scrolled away,
  // and evicting on our own adjustment can cannibalize a just-applied chunk
  // (issue #959). handleScroll consumes and clears the flag on the next scroll
  // event.
  const programmaticScrollRef = useRef(false);
  // Assign scrollTop, flagging the write as programmatic. The flag is set BEFORE
  // the assignment: a browser dispatches the scroll event asynchronously (next
  // frame), so setting it either side works there — but a synchronous scroll
  // dispatch runs handleScroll DURING the assignment, before any trailing
  // flag-set. Setting it first makes the gate correct under both timings. An
  // unchanged (clamped) scrollTop fires no scroll event, so unflag in that case,
  // otherwise the stale flag would wrongly suppress the next genuine user scroll.
  const assignScrollTop = (el: HTMLElement, top: number) => {
    const prev = el.scrollTop;
    programmaticScrollRef.current = true;
    el.scrollTop = top;
    if (el.scrollTop === prev) programmaticScrollRef.current = false;
  };

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

  // Paging-relevant snapshot bits read by the (stable) scroll handler without a
  // stale closure. See the scroll-to-top trigger + eviction in handleScroll.
  const pagingRef = useRef({ canRequestOlder: false, pagedTopChunkRowCount: 0 });
  pagingRef.current = {
    canRequestOlder: snapshot.canRequestOlder,
    pagedTopChunkRowCount: snapshot.pagedTopChunkRowCount,
  };

  // Mount reference for memory management: the instance is kept alive while this
  // view is mounted and becomes idle-evictable after unmount. release() is
  // idempotent, so Strict-Mode's double invoke is safe.
  useEffect(() => {
    const release = instance.acquire();
    return release;
  }, [instance]);

  // Record whether the user is pinned to the bottom BEFORE the DOM updates, so
  // the layout effect below can decide whether to auto-scroll. Also capture the
  // PRE-COMMIT scrollTop for the anchor effect: on a DOM SHRINK (eviction) the
  // browser clamps scrollTop to the new (smaller) max BEFORE layout effects run,
  // so reading el.scrollTop inside the effect yields an already-clamped base.
  // The anchor must compensate from the position the user actually had before
  // the change (§6.3), not the clamped one — see the effect below.
  const container = scrollRef.current;
  if (container) {
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    wasAtBottomRef.current = distance <= BOTTOM_THRESHOLD_PX;
    preCommitScrollTopRef.current = container.scrollTop;
  }

  // Prepend / eviction scroll anchoring (terminal-history-paging.md §6.3). Every
  // row is a fixed LINE_HEIGHT_PX, so rows added (prepend) or removed (evict) at
  // the TOP shift existing content by exactly delta*LINE_HEIGHT_PX. Compensating
  // scrollTop by that keeps the viewport visually stable and is immune to
  // concurrent bottom growth (unlike a whole-container scrollHeight delta) — the
  // fixed-row-height specialization of the keyed anchor-row technique. Must run
  // BEFORE the bottom-follow effect below; the two are mutually exclusive via the
  // wasAtBottom guard, and both bail in the degenerate short-content case.
  const prevPagedRowsRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    // Anchoring is a normal-buffer scrollback concept; the alt-screen carries no
    // paged rows (their counts flip to 0 while in alt) and has its own scroll
    // model. Skip here AND do not advance prevPagedRowsRef, so returning to the
    // normal buffer (count 0->N) is a no-op rather than a spurious N-row jump.
    if (snapshot.bufferType !== 'normal') return;
    const prev = prevPagedRowsRef.current;
    const curr = snapshot.pagedRowCount;
    prevPagedRowsRef.current = curr;
    if (!el || curr === prev) return;
    if (wasAtBottomRef.current) return; // bottom-follow owns this frame
    if (el.scrollHeight <= el.clientHeight) return; // nothing to compensate
    // Compensate from the PRE-COMMIT scrollTop (captured in the render-phase
    // block above), NOT el.scrollTop. On an eviction (rows removed at the top)
    // the DOM shrinks and the browser clamps scrollTop to the new max before this
    // layout effect runs; a clamped base under-compensates, so
    // `clampedBase + (0 - N)*18` lands the viewport at 0 — inside the fetch
    // trigger (scrollTop < 2*clientHeight) — which instantly re-fetches the chunk
    // we just evicted (eviction self-defeats) and jumps the viewport upward. The
    // pre-commit base preserves the user's exact position (§6.3) and, because the
    // eviction threshold is chunkHeight + 2*clientHeight, keeps the result
    // structurally >= 2*clientHeight — outside the fetch trigger. Growth (prepend)
    // never clamps, so pre-commit and post-commit bases are identical there.
    // Programmatic adjustment: must not trigger §6.4 eviction (see assignScrollTop).
    assignScrollTop(el, preCommitScrollTopRef.current + (curr - prev) * LINE_HEIGHT_PX);
  }, [snapshot]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      // Programmatic bottom-follow: must not trigger §6.4 eviction.
      assignScrollTop(el, el.scrollHeight);
    }
  }, [snapshot]);

  const [scrollTick, setScrollTick] = useState(0);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Consume the programmatic flag first: this scroll event may have been
    // fired by our own scrollTop write (anchor compensation / bottom-follow /
    // jump-to-bottom). Only the §6.4 eviction check is gated on it below; the
    // scroll-to-top fetch trigger and atBottom tracking run unconditionally.
    const wasProgrammatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance <= BOTTOM_THRESHOLD_PX);
    setScrollTick((t) => t + 1);

    // Scroll-to-top history paging (terminal-history-paging.md §6.1). Only in
    // the normal buffer (alt-screen scroll is forwarded to the app); the store
    // gates the rest (in-flight, unsupported, cap, oldestOffset>0, hasMore).
    const { canRequestOlder, pagedTopChunkRowCount } = pagingRef.current;
    const topTrigger = el.clientHeight * 2;
    if (
      bufferTypeRef.current === 'normal' &&
      canRequestOlder &&
      el.scrollTop < topTrigger
    ) {
      instance.requestOlderHistory();
    }

    // Top-side eviction (§6.4): drop the oldest paged chunk once the viewport is
    // 2+ viewport-heights below its bottom edge. Fixed row height makes the top
    // chunk's bottom exactly rows * LINE_HEIGHT_PX. Gated on !wasProgrammatic so
    // eviction only fires when the USER genuinely scrolled away — never from our
    // own bottom-follow / anchor-compensation writes, which would otherwise let
    // a programmatic pin cannibalize a just-applied chunk (issue #959).
    if (!wasProgrammatic && pagedTopChunkRowCount > 0) {
      const topChunkBottomPx = pagedTopChunkRowCount * LINE_HEIGHT_PX;
      if (el.scrollTop - topChunkBottomPx >= el.clientHeight * 2) {
        instance.evictTopChunk();
      }
    }
  }, [instance]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Programmatic jump-to-bottom: must not trigger §6.4 eviction.
    assignScrollTop(el, el.scrollHeight);
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

    // Cmd/Ctrl+A while THIS view's hidden input is focused selects the TERMINAL
    // content only (scrollback + viewport = the whole rows container), not the
    // page. Gated on our OWN input element (not any textarea) so on a page with
    // multiple terminals, select-all in one never selects another's rows. No
    // input ref -> select-all disabled (safer than a wrong-instance selection).
    const onKeyDownSelectAll = (e: KeyboardEvent) => {
      if (e.key !== 'a' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (inputRef?.current == null || document.activeElement !== inputRef.current) return;
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
  }, [instance, inputRef]);

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

      {/* History-paging status (terminal-history-paging.md §6.1/§6.4). Rendered
          as top overlays rather than in-flow rows so they never disturb the
          fixed LINE_HEIGHT_PX row grid (pointer->cell math) or the prepend
          anchor delta.

          Precedence: cap (client memory pause, releasable) > loading spinner >
          retention floor (server-side eviction, terminal). The retention-floor
          notice is intentionally NOT special-cased for the alt-screen: it is a
          statement about the archive, not the current buffer, and it is
          self-limiting — once the user scrolls down and §6.4 eviction drops the
          top chunk, evictTopChunk resets hasMoreHistory from oldestOffset and
          the derived retentionFloorReached clears on the next syncPagingMeta, so
          the notice disappears on its own without any dismiss affordance. */}
      {snapshot.pagedCapReached ? (
        <div className="absolute top-0 left-0 right-0 z-10 bg-slate-800/90 text-amber-200 text-xs px-3 py-1 text-center pointer-events-none">
          Older history paused — scroll down to release memory, then page again
        </div>
      ) : snapshot.loadingOlder ? (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 bg-slate-800/90 text-slate-300 text-xs px-3 py-1 rounded-b pointer-events-none">
          Loading older history…
        </div>
      ) : (
        snapshot.retentionFloorReached && (
          <div className="absolute top-0 left-0 right-0 z-10 bg-slate-800/90 text-slate-400 text-xs px-3 py-1 text-center pointer-events-none">
            Older history is no longer retained
          </div>
        )
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
          // The browser's own anchoring heuristic would race the manual prepend
          // compensation above; disable it so the layout effect owns anchoring.
          overflowAnchor: 'none',
        }}
      >
        {snapshot.rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            decorators={segmentDecorators}
            linkTransforms={linkTransforms}
            ctx={transformContext}
          />
        ))}
      </div>

      {/* tick = scroll events + snapshot version, so the thumb appears on scroll
          and on content growth, then fades after inactivity. */}
      <TerminalScrollIndicator containerRef={scrollRef} tick={scrollTick + snapshot.version} />

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
