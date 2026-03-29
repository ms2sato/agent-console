import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTerminalWebSocket, type WorkerError } from '../hooks/useTerminalWebSocket';
import { useAppWsEvent } from '../hooks/useAppWs';
import { disconnect, requestHistory } from '../lib/worker-websocket.js';
import { isScrolledToBottom, stripScrollbackClear as applyScrollbackFilter } from '../lib/terminal-utils.js';
import { writeFullHistory } from '../lib/terminal-chunk-writer.js';
import { saveTerminalState, loadTerminalState, clearTerminalState, getCurrentServerPid } from '../lib/terminal-state-cache.js';
import {
  register as registerSaveManager,
  unregister as unregisterSaveManager,
  markDirty as markSaveManagerDirty,
} from '../lib/terminal-state-save-manager.js';
import { deleteSession } from '../lib/api.js';
import { emitSessionDeleted } from '../lib/app-websocket.js';
import type { AgentActivityState } from '@agent-console/shared';
import { logger } from '../lib/logger';
import { createRenderWatchdog, type RenderWatchdog } from '../lib/render-diagnostics.js';
import { ChevronDownIcon, SpinnerIcon } from './Icons';
import { WorkerErrorRecovery } from './WorkerErrorRecovery';

/**
 * State for conditional rendering support.
 * Tracks whether xterm.js is initialized and stores history that arrives before initialization.
 */
interface TerminalState {
  isMounted: boolean;           // Is xterm.js initialized?
  cacheProcessed: boolean;      // Has loadTerminalState() completed (success or failure)?
  historyRequested: boolean;    // Has history been requested? (prevent duplicate requests)
  requestedWithOffset: number;  // The offset used when history was requested
  currentWorkerId: string;      // Current worker ID for race condition detection
  mountGeneration: number;      // Counter for mount cycles to detect stale async operations
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'exited';

export interface TerminalProps {
  sessionId: string;
  workerId: string;
  onStatusChange?: (status: ConnectionStatus, exitInfo?: { code: number; signal: string | null }) => void;
  onActivityChange?: (state: AgentActivityState) => void;
  onRequestRestart?: (continueConversation: boolean) => void;
  onResumeSession?: () => void;
  onFilesReceived?: (files: File[]) => void;
  hideStatusBar?: boolean;
  stripScrollbackClear?: boolean;
}

/** Minimal terminal interface needed for scroll position restoration.
 * Allows testing without depending on the full xterm.js Terminal type. */
export interface ScrollableTerminal {
  buffer: {
    active: {
      viewportY: number;
      baseY: number;
      length: number;
    };
  };
  rows: number;
  scrollToBottom: () => void;
  scrollLines: (amount: number) => void;
}

/** Restore scroll position when viewportY is corrupted by alternate screen
 * buffer transitions or render stalls. Uses distanceFromBottom (saved via
 * wheel events) which is stable across buffer trimming. */
export function restoreScrollPosition(
  terminal: ScrollableTerminal,
  savedScroll: { distanceFromBottom: number }
): void {
  if (isScrolledToBottom(terminal)) return;
  if (savedScroll.distanceFromBottom === 0) {
    terminal.scrollToBottom();
  } else {
    const targetY = terminal.buffer.active.baseY - savedScroll.distanceFromBottom;
    if (terminal.buffer.active.viewportY !== targetY) {
      terminal.scrollLines(targetY - terminal.buffer.active.viewportY);
    }
  }
}

export function Terminal({ sessionId, workerId, onStatusChange, onActivityChange, onRequestRestart, onResumeSession, onFilesReceived, hideStatusBar, stripScrollbackClear }: TerminalProps) {
  const navigate = useNavigate();

  /** Conditionally apply scrollback filter based on the stripScrollbackClear prop. */
  const processOutput = useCallback(
    (data: string) => stripScrollbackClear ? applyScrollbackFilter(data) : data,
    [stripScrollbackClear]
  );

  const processOutputRef = useRef(processOutput);
  useEffect(() => {
    processOutputRef.current = processOutput;
  }, [processOutput]);

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const stateRef = useRef<TerminalState>({
    isMounted: false,
    cacheProcessed: false,
    historyRequested: false,
    requestedWithOffset: 0,
    currentWorkerId: workerId,
    mountGeneration: 0,
  });
  const [cacheProcessed, setCacheProcessed] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const offsetRef = useRef<number>(0);
  const connectedRef = useRef(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | null>(null);
  const [workerError, setWorkerError] = useState<WorkerError | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const onFilesReceivedRef = useRef(onFilesReceived);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [truncationWarning, setTruncationWarning] = useState<string | null>(null);
  const truncationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [restartNotification, setRestartNotification] = useState<string | null>(null);
  const restartNotificationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const watchdogRef = useRef<RenderWatchdog | null>(null);
  // User's scroll position saved via wheel events for corruption recovery.
  // distanceFromBottom is stable across buffer trimming (unlike absolute viewportY).
  const savedScrollRef = useRef({ distanceFromBottom: 0 });

  // Mutation for deleting session on error recovery
  const deleteSessionMutation = useMutation({
    mutationFn: () => deleteSession(sessionId),
    onSuccess: () => {
      emitSessionDeleted(sessionId);
      navigate({ to: '/' });
    },
  });

  // Handler for retrying worker connection
  const handleRetry = useCallback(() => {
    // Disconnect and increment retry count to trigger reconnection
    disconnect(sessionId, workerId);
    setWorkerError(null);
    setRetryCount((c) => c + 1);
  }, [sessionId, workerId]);

  // Handler for deleting session on unrecoverable errors
  const handleDeleteSession = useCallback(() => {
    deleteSessionMutation.mutate();
  }, [deleteSessionMutation]);

  // Handler for navigating to dashboard
  const handleGoToDashboard = useCallback(() => {
    navigate({ to: '/' });
  }, [navigate]);

  // Notify parent of status changes
  useEffect(() => {
    onStatusChange?.(status, exitInfo ?? undefined);
  }, [status, exitInfo, onStatusChange]);

  const updateScrollButtonVisibility = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      setShowScrollButton(false);
      return;
    }
    const atBottom = isScrolledToBottom(terminal);
    setShowScrollButton(!atBottom);
  }, []);

  /**
   * Save terminal state to IndexedDB cache.
   * This is called after history is written to keep the cache fresh.
   * Follows the same error handling pattern as the cleanup function.
   */
  const saveCurrentTerminalState = useCallback(() => {
    const terminal = terminalRef.current;
    const serializeAddon = serializeAddonRef.current;
    if (!terminal || !serializeAddon) {
      return;
    }

    try {
      const serializedData = serializeAddon.serialize();
      const serverPid = getCurrentServerPid();
      saveTerminalState(sessionId, workerId, {
        data: serializedData,
        savedAt: Date.now(),
        cols: terminal.cols,
        rows: terminal.rows,
        offset: offsetRef.current,
        ...(serverPid !== null ? { serverPid } : {}),
      }).catch((e) => logger.warn('[Terminal] Failed to save terminal state after history:', e));
    } catch (e) {
      logger.warn('[Terminal] Failed to serialize terminal state after history:', e);
    }
  }, [sessionId, workerId]);

  const handleScrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    savedScrollRef.current.distanceFromBottom = 0;
    setShowScrollButton(false);
  }, []);

  const handleOutput = useCallback((data: string, offset: number) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    watchdogRef.current?.onWriteStart(data.length, offset);
    offsetRef.current = offset;
    terminal.write(processOutput(data), () => {
      watchdogRef.current?.onWriteComplete();
      restoreScrollPosition(terminal, savedScrollRef.current);
      updateScrollButtonVisibility();
    });
    // Mark as dirty for idle-based save (replaces fire-and-forget saves)
    markSaveManagerDirty(sessionId, workerId);
  }, [sessionId, workerId, updateScrollButtonVisibility, processOutput]);

  const handleHistory = useCallback((data: string, offset: number) => {
    setLoadingHistory(false);
    watchdogRef.current?.onHistoryReceived(data.length, offset);
    offsetRef.current = offset;

    const terminal = terminalRef.current;
    if (!terminal) return;

    // Detect server-side truncation: response offset is lower than requested offset.
    // This means the file was truncated and the client's cached state is stale.
    // Reset terminal and treat as full history load.
    const truncationDetected = stateRef.current.requestedWithOffset > 0
      && offset < stateRef.current.requestedWithOffset;
    if (truncationDetected) {
      logger.warn('[Terminal] History offset regression detected (file truncated), resetting terminal', {
        requestedOffset: stateRef.current.requestedWithOffset,
        receivedOffset: offset,
      });
      // Clear stale cache
      clearTerminalState(sessionId, workerId).catch((e) =>
        logger.warn('[Terminal] Failed to clear terminal cache on truncation resync:', e)
      );
      // Reset to full history mode
      stateRef.current.requestedWithOffset = 0;
    }

    if (stateRef.current.requestedWithOffset > 0) {
      // Had cache — append diff
      if (data) {
        terminal.write(processOutput(data), () => {
          watchdogRef.current?.onHistoryWriteComplete();
          restoreScrollPosition(terminal, savedScrollRef.current);
          updateScrollButtonVisibility();
          saveCurrentTerminalState();
        });
      } else {
        watchdogRef.current?.onHistoryWriteComplete();
        saveCurrentTerminalState();
      }
    } else {
      // No cache — full history
      if (!data) return;
      writeFullHistory(terminal, processOutput(data))
        .then(() => {
          watchdogRef.current?.onHistoryWriteComplete();
          updateScrollButtonVisibility();
          saveCurrentTerminalState();
        })
        .catch((e) => logger.error('[Terminal] Failed to write history:', e));
    }
  }, [sessionId, workerId, updateScrollButtonVisibility, saveCurrentTerminalState, processOutput]);

  const handleExit = useCallback((exitCode: number, signal: string | null) => {
    setStatus('exited');
    setExitInfo({ code: exitCode, signal });
  }, []);

  const handleConnectionChange = useCallback((connected: boolean) => {
    connectedRef.current = connected;
    setStatus(connected ? 'connected' : 'disconnected');

    if (!connected) {
      // Reset historyRequested so reconnect will re-request
      stateRef.current.historyRequested = false;
      setLoadingHistory(false);
    }
  }, []);

  const handleActivity = useCallback((state: AgentActivityState) => {
    onActivityChange?.(state);
  }, [onActivityChange]);

  /**
   * Reset terminal state to prepare for fresh history.
   * Shared by handleOutputTruncated and handleWorkerRestarted.
   */
  const resetTerminalForFreshHistory = useCallback(() => {
    offsetRef.current = 0;
    stateRef.current.historyRequested = false;
    stateRef.current.requestedWithOffset = 0;
  }, []);

  const handleOutputTruncated = useCallback((message: string, newOffset: number) => {
    if (truncationTimeoutRef.current) {
      clearTimeout(truncationTimeoutRef.current);
    }
    setTruncationWarning(message);
    truncationTimeoutRef.current = setTimeout(() => {
      setTruncationWarning(null);
      truncationTimeoutRef.current = null;
    }, 10000);

    // Just update offset — no need to re-render terminal content.
    // The xterm.js terminal still has valid content; the server only removed
    // old data from the beginning of the file.
    offsetRef.current = newOffset;
  }, []);

  // Handle worker-restarted event from app WebSocket
  const handleWorkerRestarted = useCallback((restartedSessionId: string, restartedWorkerId: string) => {
    if (restartedSessionId !== sessionId || restartedWorkerId !== workerId) {
      return;
    }

    logger.debug(`[Terminal] Worker restarted: ${sessionId}/${workerId}`);

    // Show restart notification with auto-dismiss
    if (restartNotificationTimeoutRef.current) {
      clearTimeout(restartNotificationTimeoutRef.current);
    }
    setRestartNotification('Terminal restarted');
    restartNotificationTimeoutRef.current = setTimeout(() => {
      setRestartNotification(null);
      restartNotificationTimeoutRef.current = null;
    }, 5000);

    // Clear IndexedDB terminal cache (fire-and-forget)
    clearTerminalState(sessionId, workerId).catch((e) =>
      logger.warn('[Terminal] Failed to clear terminal cache on restart:', e)
    );

    resetTerminalForFreshHistory();
    // Immediately clear the terminal to visually indicate restart
    terminalRef.current?.reset();

    // Reset exit state so the terminal reconnects
    setExitInfo(null);
    setStatus('connecting');

    // Disconnect and trigger reconnection
    disconnect(sessionId, workerId);
    setRetryCount((c) => c + 1);
  }, [sessionId, workerId, resetTerminalForFreshHistory]);

  useAppWsEvent({
    onWorkerRestarted: handleWorkerRestarted,
  });

  const { sendInput, sendResize, connected, error } = useTerminalWebSocket(
    sessionId,
    workerId,
    {
      onOutput: handleOutput,
      onHistory: handleHistory,
      onExit: handleExit,
      onConnectionChange: handleConnectionChange,
      onActivity: handleActivity,
      onOutputTruncated: handleOutputTruncated,
    },
    retryCount
  );

  // Keep onFilesReceivedRef in sync with the prop to avoid stale closures
  // in xterm event handlers (paste, drop) without re-running the xterm init effect
  useEffect(() => {
    onFilesReceivedRef.current = onFilesReceived;
  }, [onFilesReceived]);

  // Sync connected value from hook to ref for use in async callbacks
  // (The ref is also updated in handleConnectionChange, but this handles the initial value)
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Sync error from hook to local state
  useEffect(() => {
    setWorkerError(error);
  }, [error]);

  // Initialize xterm.js
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#eee',
        cursor: '#eee',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Enable clickable URLs in terminal output
    // Use noopener,noreferrer to prevent reverse tabnabbing attacks
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    });
    terminal.loadAddon(webLinksAddon);

    // Enable serialization for terminal state caching
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);

    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    // Create render diagnostics watchdog (no-op when diagnostics disabled)
    const watchdog = createRenderWatchdog(sessionId, workerId, terminal);
    watchdogRef.current = watchdog;
    watchdog.start();

    // WORKAROUND: xterm.js render stall auto-recovery
    // xterm.js occasionally stops scheduling renders after terminal.write() completes,
    // causing the terminal display to freeze while data continues to arrive.
    // See: docs/issues/terminal-render-stall-2026-03-21.md
    //
    // Two known stall scenarios:
    // 1. The event chain from buffer update to _renderDebouncer.refresh() breaks
    //    (original issue — debouncer.refresh() simply stops being called)
    // 2. RenderService._isPaused gets stuck as true (IntersectionObserver reports
    //    the terminal as not visible), causing refreshRows() to short-circuit
    //    before reaching the debouncer
    //
    // Detection: hook terminal.write() and _renderDebouncer.refresh().
    // If writes happen without corresponding debouncer refresh calls within 2 seconds,
    // force a render. Hooking the debouncer (not refreshRows) correctly detects
    // stalls regardless of _isPaused state.
    const renderStallRecovery = (() => {
      let writeCount = 0;
      let refreshCount = 0;
      let lastWriteCount = 0;
      let lastRefreshCount = 0;

      // Hook terminal.write to count writes
      const origWrite = terminal.write.bind(terminal);
      terminal.write = function(data: string | Uint8Array, callback?: () => void) {
        writeCount++;
        return origWrite(data, callback);
      };

      // Hook _renderDebouncer.refresh to count actual render scheduling.
      // Unlike refreshRows (which short-circuits when _isPaused is true),
      // this counts only calls that actually reach the render debouncer.
      const renderService = (terminal as any)._core?._renderService;
      const debouncer = renderService?._renderDebouncer;
      const origDebouncerRefresh = debouncer?.refresh?.bind(debouncer);
      if (debouncer && origDebouncerRefresh) {
        debouncer.refresh = function(start: number, end: number, rowCount: number) {
          refreshCount++;
          return origDebouncerRefresh(start, end, rowCount);
        };
      }

      const intervalId = setInterval(() => {
        const newWrites = writeCount - lastWriteCount;
        const newRefreshes = refreshCount - lastRefreshCount;
        const stallDetected = newWrites > 0 && newRefreshes === 0;
        if (stallDetected) {
          if (document.visibilityState === 'visible') {
            const isPaused = renderService?._isPaused;
            logger.warn('[Terminal] Render stall detected', {
              sessionId,
              workerId,
              writes: newWrites,
              isPaused,
              needsFullRefresh: renderService?._needsFullRefresh,
            });
            // If _isPaused is stuck, reset it so terminal.refresh() can work
            if (isPaused) {
              renderService._isPaused = false;
            }
            terminal.refresh(0, terminal.rows - 1);
            restoreScrollPosition(terminal, savedScrollRef.current);
          } else {
            // Stall detected while hidden — do NOT advance baselines.
            // The stall will be recovered on the next visible interval.
            return;
          }
        }
        lastWriteCount = writeCount;
        lastRefreshCount = refreshCount;
      }, 2000);

      return {
        dispose() {
          clearInterval(intervalId);
          terminal.write = origWrite;
          if (debouncer && origDebouncerRefresh) {
            debouncer.refresh = origDebouncerRefresh;
          }
        },
      };
    })();

    // Mark as mounted for conditional rendering support
    stateRef.current.isMounted = true;
    // Store current worker ID for race condition detection
    stateRef.current.currentWorkerId = workerId;
    // Increment mount generation counter to detect stale async operations
    const currentGeneration = ++stateRef.current.mountGeneration;
    // Create AbortController for this mount cycle to cancel in-flight cache loads on tab switch
    const abortController = new AbortController();

    // Register state getter with save manager for idle-based saves
    const stateGetter = () => {
      if (!terminalRef.current || !serializeAddonRef.current) return null;
      // Don't save state if terminal hasn't received history yet
      // This prevents saving empty/partial state during rapid tab switching
      if (!stateRef.current.historyRequested) {
        return null;
      }
      try {
        const serverPid = getCurrentServerPid();
        return {
          data: serializeAddonRef.current.serialize(),
          savedAt: Date.now(),
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
          offset: offsetRef.current,
          ...(serverPid !== null ? { serverPid } : {}),
        };
      } catch {
        return null;
      }
    };
    registerSaveManager(sessionId, workerId, stateGetter);

    // Try to restore terminal state from cache before processing server history
    // This eliminates flickering when switching between workers
    loadTerminalState(sessionId, workerId, abortController.signal)
      .then(async (cached) => {
        // AbortController cancelled this operation (tab switched during cache load)
        if (abortController.signal.aborted) return;

        // Existing stale checks remain as defense-in-depth
        // Race condition check: abort if component unmounted, worker changed, or mount generation changed
        if (!stateRef.current.isMounted) {
          logger.debug('[Terminal] Abandoned cache read: component unmounted for workerId:', workerId);
          return;
        }
        if (stateRef.current.currentWorkerId !== workerId) {
          logger.debug('[Terminal] Abandoned cache read for stale workerId:', workerId);
          return;
        }
        if (stateRef.current.mountGeneration !== currentGeneration) {
          logger.debug('[Terminal] Abandoned cache read for stale mount generation:', currentGeneration, 'current:', stateRef.current.mountGeneration);
          return;
        }

        // Use terminalRef.current instead of captured terminal variable
        // to handle React Strict Mode double-mounting
        const currentTerminal = terminalRef.current;
        if (cached && cached.data && currentTerminal) {
          // Restore cached terminal state
          currentTerminal.write(processOutputRef.current(cached.data), () => {
            updateScrollButtonVisibility();
          });
          offsetRef.current = cached.offset;
        } else {
          offsetRef.current = 0;
        }

        stateRef.current.cacheProcessed = true;
        setCacheProcessed(true);
      })
      .catch((e) => {
        // Silently ignore aborted operations (not an error)
        if (abortController.signal.aborted) return;

        logger.warn('[Terminal] Failed to load cached state:', e);
        setCacheError('Failed to load cached terminal state');

        // Race condition check: abort if component unmounted, worker changed, or mount generation changed
        if (!stateRef.current.isMounted) {
          logger.debug('[Terminal] Abandoned cache read (error path): component unmounted for workerId:', workerId);
          return;
        }
        if (stateRef.current.currentWorkerId !== workerId) {
          logger.debug('[Terminal] Abandoned cache read (error path) for stale workerId:', workerId);
          return;
        }
        if (stateRef.current.mountGeneration !== currentGeneration) {
          logger.debug('[Terminal] Abandoned cache read (error path) for stale mount generation:', currentGeneration, 'current:', stateRef.current.mountGeneration);
          return;
        }

        // Fallback: no cache, offset 0
        offsetRef.current = 0;
        stateRef.current.cacheProcessed = true;
        setCacheProcessed(true);
      });

    // Delay fit to ensure container has dimensions
    const fitTerminal = () => {
      if (container.offsetHeight > 0 && container.offsetWidth > 0) {
        try {
          fitAddon.fit();
        } catch (e) {
          logger.warn('Failed to fit terminal:', e);
        }
      }
    };

    // Initial fit with delay
    const rafId = requestAnimationFrame(fitTerminal);

    // Handle terminal input
    terminal.onData((data) => {
      sendInput(data);
    });

    // Handle special key events
    terminal.attachCustomKeyEventHandler((event) => {
      // Skip IME composition events (Japanese input, etc.)
      if (event.isComposing) {
        return true; // Let IME handle it
      }

      // Handle Shift+Enter for multi-line input
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        // Send soft newline for multi-line input
        sendInput('\x0a');
        return false; // Prevent terminal from handling
      }

      return true; // Allow default handling for other keys
    });

    // Handle resize
    const handleResize = () => {
      fitTerminal();
      if (terminal.cols && terminal.rows) {
        sendResize(terminal.cols, terminal.rows);
      }
    };

    // Handle paste with image detection
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items || !onFilesReceivedRef.current) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      if (imageFiles.length > 0) {
        event.preventDefault();
        onFilesReceivedRef.current(imageFiles);
      }
      // If no image, let xterm handle normal text paste
    };

    // Handle drag-and-drop image upload
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) {
        setIsDragOver(true);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current === 0) {
        setIsDragOver(false);
      }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      if (!onFilesReceivedRef.current) return;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      onFilesReceivedRef.current(Array.from(files));
    };

    // Save user's scroll position via wheel events for corruption recovery.
    // Captures distanceFromBottom which is stable across buffer trimming
    // (unlike absolute viewportY which shifts when old lines are removed).
    const handleWheel = () => {
      requestAnimationFrame(() => {
        const t = terminalRef.current;
        if (!t) return;
        savedScrollRef.current.distanceFromBottom = t.buffer.active.baseY - t.buffer.active.viewportY;
      });
    };
    container.addEventListener('wheel', handleWheel, { passive: true });

    container.addEventListener('paste', handlePaste);
    container.addEventListener('dragenter', handleDragEnter);
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('dragleave', handleDragLeave);
    container.addEventListener('drop', handleDrop);
    window.addEventListener('resize', handleResize);

    // Listen for scroll events to update scroll-to-bottom button visibility
    const scrollDisposable = terminal.onScroll(() => {
      updateScrollButtonVisibility();
    });

    // Handle DOM scroll events from any source
    const handleDOMScroll = () => {
      updateScrollButtonVisibility();
    };

    // Use capture phase to catch scroll events from children
    container.addEventListener('scroll', handleDOMScroll, { capture: true });

    // Listen to scroll events on the xterm viewport element
    // The viewport is the actual scrollable element within xterm
    let viewportElement: Element | null = container.querySelector('.xterm-viewport');

    if (viewportElement) {
      viewportElement.addEventListener('scroll', handleDOMScroll);
    }

    // Use MutationObserver to detect when .xterm-viewport is added to DOM
    // This is more reliable than setTimeout because it reacts immediately when the element appears
    let viewportListenerAdded = !!viewportElement;
    const viewportObserver = new MutationObserver(() => {
      if (viewportListenerAdded) return;

      const observedViewportElement = container.querySelector('.xterm-viewport');
      if (observedViewportElement) {
        observedViewportElement.addEventListener('scroll', handleDOMScroll);
        viewportElement = observedViewportElement; // Update reference for cleanup
        viewportListenerAdded = true;
        viewportObserver.disconnect(); // Stop observing once found
      }
    });

    viewportObserver.observe(container, {
      childList: true,
      subtree: true
    });

    return () => {
      // Dispose render stall auto-recovery before watchdog
      renderStallRecovery.dispose();

      // Dispose render diagnostics watchdog
      watchdog.dispose();
      watchdogRef.current = null;

      // Abort any in-flight cache load to prevent stale data from being written to terminal
      abortController.abort();

      // Unregister from save manager - this triggers final save (async, best-effort)
      unregisterSaveManager(sessionId, workerId)
        .catch((e) => logger.warn('[Terminal] Failed to save on unmount:', e));

      // Reset state for conditional rendering support
      // Note: mountGeneration is NOT reset here - it's incremented on mount to detect stale operations
      const currentMountGeneration = stateRef.current.mountGeneration;
      stateRef.current = {
        isMounted: false,
        cacheProcessed: false,
        historyRequested: false,
        requestedWithOffset: 0,
        currentWorkerId: '',
        mountGeneration: currentMountGeneration,
      };
      setCacheProcessed(false);
      offsetRef.current = 0;

      cancelAnimationFrame(rafId);
      viewportObserver.disconnect();

      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('paste', handlePaste);
      container.removeEventListener('dragenter', handleDragEnter);
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('dragleave', handleDragLeave);
      container.removeEventListener('drop', handleDrop);
      dragCounterRef.current = 0;
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('scroll', handleDOMScroll, { capture: true });
      if (viewportElement) {
        viewportElement.removeEventListener('scroll', handleDOMScroll);
      }
      scrollDisposable.dispose();
      // Delay disposal to allow any pending xterm.js operations to complete
      // This prevents "Cannot read properties of undefined (reading 'dimensions')" errors
      // from xterm.js internal code trying to access disposed terminal
      setTimeout(() => {
        // Null out refs just before disposal to allow callbacks to write to terminal
        // until the last moment (important for React Strict Mode double-render)
        if (terminalRef.current === terminal) {
          terminalRef.current = null;
        }
        if (fitAddonRef.current === fitAddon) {
          fitAddonRef.current = null;
        }
        if (serializeAddonRef.current === serializeAddon) {
          serializeAddonRef.current = null;
        }
        terminal.dispose();
      }, 0);
    };
  }, [sessionId, workerId, sendInput, sendResize, updateScrollButtonVisibility]);

  // Send resize when connection is established
  useEffect(() => {
    if (connected && terminalRef.current && fitAddonRef.current) {
      fitAddonRef.current.fit();
      sendResize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [connected, sendResize]);

  // Single source of truth for requesting history
  useEffect(() => {
    if (connected && cacheProcessed && !stateRef.current.historyRequested) {
      const fromOffset = offsetRef.current;
      stateRef.current.historyRequested = true;
      stateRef.current.requestedWithOffset = fromOffset;
      setLoadingHistory(true);
      requestHistory(sessionId, workerId, fromOffset);
    }
  }, [connected, cacheProcessed, sessionId, workerId]);

  // Clean up notification timeouts on unmount
  useEffect(() => {
    return () => {
      if (truncationTimeoutRef.current) {
        clearTimeout(truncationTimeoutRef.current);
      }
      if (restartNotificationTimeoutRef.current) {
        clearTimeout(restartNotificationTimeoutRef.current);
      }
    };
  }, []);

  function getStatusColor(): string {
    if (workerError) return 'bg-red-500';
    switch (status) {
      case 'connected': return 'bg-green-500';
      case 'connecting': return 'bg-yellow-500';
      case 'exited': return 'bg-red-500';
      case 'disconnected': return 'bg-gray-500';
    }
  }

  function getStatusText(): string {
    if (workerError) return 'Error';
    switch (status) {
      case 'connecting': return 'Connecting...';
      case 'connected': return 'Connected';
      case 'disconnected': return 'Disconnected';
      case 'exited':
        return `Exited (code: ${exitInfo?.code}${exitInfo?.signal ? `, signal: ${exitInfo.signal}` : ''})`;
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {!hideStatusBar && (
        <div className="px-3 py-2 bg-slate-900 border-b border-gray-700 flex items-center gap-3 shrink-0">
          <span className={`inline-block w-2 h-2 rounded-full ${getStatusColor()}`} />
          <span className="text-gray-500 text-sm">
            {getStatusText()}
          </span>
          {loadingHistory && (
            <span className="text-blue-400 text-xs flex items-center gap-1.5 ml-auto">
              <SpinnerIcon className="w-3 h-3" />
              Loading history...
            </span>
          )}
        </div>
      )}
      {cacheError && (
        <div className="bg-yellow-500/20 text-yellow-400 text-xs px-3 py-2 border-b border-yellow-500/30 flex items-center justify-between shrink-0">
          <span>{cacheError}</span>
          <button
            onClick={() => setCacheError(null)}
            className="ml-2 underline hover:text-yellow-300"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={containerRef} className="absolute inset-0 bg-slate-800 p-2" />
        {workerError && (
          <WorkerErrorRecovery
            errorCode={workerError.code}
            errorMessage={workerError.message}
            onRetry={handleRetry}
            onDeleteSession={handleDeleteSession}
            onGoToDashboard={handleGoToDashboard}
            onRestart={onRequestRestart}
            onResumeSession={onResumeSession}
          />
        )}
        {/* Truncation warning banner */}
        {truncationWarning && (
          <div className="absolute top-0 left-0 right-0 bg-amber-600/90 text-white px-4 py-2 text-sm flex items-center justify-between z-10">
            <span>{truncationWarning}</span>
            <button
              onClick={() => setTruncationWarning(null)}
              className="ml-4 text-white/80 hover:text-white font-bold"
              aria-label="Dismiss warning"
            >
              x
            </button>
          </div>
        )}
        {/* Restart notification banner */}
        {restartNotification && (
          <div className="absolute top-0 left-0 right-0 bg-blue-600/90 text-white px-4 py-2 text-sm flex items-center justify-between z-10">
            <span>{restartNotification}</span>
            <button
              onClick={() => setRestartNotification(null)}
              className="ml-4 text-white/80 hover:text-white font-bold"
              aria-label="Dismiss notification"
            >
              x
            </button>
          </div>
        )}
        {/* Drag-over overlay for file drop */}
        {isDragOver && (
          <div className="absolute inset-0 bg-blue-500/20 border-2 border-dashed border-blue-400 flex items-center justify-center z-10 pointer-events-none">
            <span className="text-blue-300 text-lg font-medium">Drop file here</span>
          </div>
        )}
        {/* Scroll to bottom button */}
        <button
          onClick={handleScrollToBottom}
          className={`absolute bottom-4 right-4 p-2 bg-slate-700 hover:bg-slate-600 rounded-full shadow-lg border border-slate-600 text-gray-300 hover:text-white transition-all duration-200 ${
            showScrollButton
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 translate-y-2 pointer-events-none'
          }`}
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
        >
          <ChevronDownIcon className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Memoized Terminal component that prevents unnecessary re-renders.
 *
 * With conditional rendering, Terminal only renders when active, so the main
 * optimization is to ignore callback reference changes from parent re-renders.
 *
 * Optimization rules:
 * - sessionId/workerId changed: re-render (different terminal)
 * - hideStatusBar changed: re-render (UI change)
 * - Only callback refs changed: skip re-render (avoid re-render from parent)
 */
export const MemoizedTerminal = React.memo(Terminal, (prevProps, nextProps) => {
  // Identity changed: need re-render
  if (
    prevProps.sessionId !== nextProps.sessionId ||
    prevProps.workerId !== nextProps.workerId
  ) {
    return false; // Changed (re-render)
  }

  // hideStatusBar changed: need re-render
  if (prevProps.hideStatusBar !== nextProps.hideStatusBar) {
    return false; // Changed (re-render)
  }

  // stripScrollbackClear changed: need re-render (stable per worker, but must stay current)
  if (prevProps.stripScrollbackClear !== nextProps.stripScrollbackClear) {
    return false; // Changed (re-render)
  }

  // onRequestRestart and onResumeSession drive error recovery behavior and must stay current
  if (prevProps.onRequestRestart !== nextProps.onRequestRestart) {
    return false; // Changed (re-render)
  }
  if (prevProps.onResumeSession !== nextProps.onResumeSession) {
    return false; // Changed (re-render)
  }

  // Ignore callback reference changes (onStatusChange, onActivityChange)
  // These are likely recreated on parent re-render but functionally equivalent
  return true; // No meaningful change (skip re-render)
});
