import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useTerminalWebSocket, type WorkerError } from '../hooks/useTerminalWebSocket';
import { clearVisibilityTracking, requestHistory } from '../lib/worker-websocket.js';
import { isScrolledToBottom } from '../lib/terminal-utils.js';
import { writeFullHistory } from '../lib/terminal-chunk-writer.js';
import { saveTerminalState, loadTerminalState } from '../lib/terminal-state-cache.js';
import type { AgentActivityState } from '@agent-console/shared';
import { ChevronDownIcon } from './Icons';

/**
 * State for conditional rendering support.
 * Tracks whether xterm.js is initialized and stores history that arrives before initialization.
 */
interface TerminalState {
  isMounted: boolean;           // Is xterm.js initialized?
  pendingHistory: string | null; // History that arrived before xterm.js was ready
  restoredFromCache: boolean;   // Was the terminal restored from cache? (skip server history if true)
  waitingForDiff: boolean;      // Are we waiting for a diff response after cache restoration?
  cachedOffset: number;         // The offset from the cached state (for diff requests)
  historyRequested: boolean;    // Has history been requested? (prevent duplicate requests)
  currentWorkerId: string;      // Current worker ID for race condition detection
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'exited';

export interface TerminalProps {
  sessionId: string;
  workerId: string;
  onStatusChange?: (status: ConnectionStatus, exitInfo?: { code: number; signal: string | null }) => void;
  onActivityChange?: (state: AgentActivityState) => void;
  hideStatusBar?: boolean;
}

export function Terminal({ sessionId, workerId, onStatusChange, onActivityChange, hideStatusBar }: TerminalProps) {

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const stateRef = useRef<TerminalState>({
    isMounted: false,
    pendingHistory: null,
    restoredFromCache: false,
    waitingForDiff: false,
    cachedOffset: 0,
    historyRequested: false,
    currentWorkerId: workerId,
  });
  const offsetRef = useRef<number>(0);
  const connectedRef = useRef(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | null>(null);
  const [workerError, setWorkerError] = useState<WorkerError | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [truncationWarning, setTruncationWarning] = useState<string | null>(null);
  const truncationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      saveTerminalState(sessionId, workerId, {
        data: serializedData,
        savedAt: Date.now(),
        cols: terminal.cols,
        rows: terminal.rows,
        offset: offsetRef.current,
      }).catch((e) => console.warn('[Terminal] Failed to save terminal state after history:', e));
    } catch (e) {
      console.warn('[Terminal] Failed to serialize terminal state after history:', e);
    }
  }, [sessionId, workerId]);

  const handleScrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    setShowScrollButton(false);
  }, []);

  const handleOutput = useCallback((data: string, offset: number) => {
    offsetRef.current = offset;
    terminalRef.current?.write(data, () => {
      updateScrollButtonVisibility();
    });
  }, [updateScrollButtonVisibility]);

  const handleHistory = useCallback((data: string, offset: number) => {
    // Update offset
    offsetRef.current = offset;

    // Handle history response based on whether we restored from cache
    if (stateRef.current.waitingForDiff) {
      stateRef.current.waitingForDiff = false;

      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      if (stateRef.current.restoredFromCache) {
        // Restored from cache - append diff data (do NOT clear terminal)
        if (data) {
          terminal.write(data, () => {
            updateScrollButtonVisibility();
            saveCurrentTerminalState();
          });
        } else {
          // No diff data, but cache was restored - save state to update offset
          saveCurrentTerminalState();
        }
      } else {
        // No cache - write full history
        if (data) {
          writeFullHistory(terminal, data)
            .then(() => {
              updateScrollButtonVisibility();
              saveCurrentTerminalState();
            })
            .catch((e) => console.error('[Terminal] Failed to write history:', e));
        } else {
          // No data and no cache - save empty state
          saveCurrentTerminalState();
        }
      }
      return;
    }

    // Skip server history if we already restored from cache and not waiting for diff
    // This prevents the flickering caused by clearing and rewriting content
    if (stateRef.current.restoredFromCache) {
      return;
    }

    if (!data) return;

    // xterm.js not ready yet -> store temporarily
    if (!stateRef.current.isMounted) {
      stateRef.current.pendingHistory = data;
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // xterm.js is ready -> write full history
    writeFullHistory(terminal, data)
      .then(() => {
        updateScrollButtonVisibility();
        saveCurrentTerminalState();
      })
      .catch((e) => console.error('[Terminal] Failed to write history:', e));
  }, [updateScrollButtonVisibility, saveCurrentTerminalState]);

  const handleExit = useCallback((exitCode: number, signal: string | null) => {
    setStatus('exited');
    setExitInfo({ code: exitCode, signal });
  }, []);

  const handleConnectionChange = useCallback((connected: boolean) => {
    connectedRef.current = connected;
    setStatus(connected ? 'connected' : 'disconnected');

    if (connected) {
      // Reconnected: re-request history if we were waiting for it but lost connection
      // This handles the case where WebSocket disconnected during cache restore flow
      if (stateRef.current.restoredFromCache && !stateRef.current.historyRequested) {
        const fromOffset = stateRef.current.cachedOffset;
        stateRef.current.historyRequested = true;
        stateRef.current.waitingForDiff = true;
        requestHistory(sessionId, workerId, fromOffset);
      }
    } else {
      // Disconnected: reset historyRequested flag so next reconnect can request history
      // Keep waitingForDiff and restoredFromCache so we know to re-request
      stateRef.current.historyRequested = false;
    }
  }, [sessionId, workerId]);

  const handleActivity = useCallback((state: AgentActivityState) => {
    onActivityChange?.(state);
  }, [onActivityChange]);

  const handleOutputTruncated = useCallback((message: string) => {
    // Clear any existing timeout
    if (truncationTimeoutRef.current) {
      clearTimeout(truncationTimeoutRef.current);
    }

    // Show warning banner with auto-dismiss after 10 seconds
    setTruncationWarning(message);
    truncationTimeoutRef.current = setTimeout(() => {
      setTruncationWarning(null);
      truncationTimeoutRef.current = null;
    }, 10000);

    // Reset offset tracking to resync with server
    offsetRef.current = 0;
    stateRef.current.cachedOffset = 0;
    stateRef.current.historyRequested = false;
    stateRef.current.waitingForDiff = false;
    stateRef.current.restoredFromCache = false;

    // Clear terminal to show that history was lost
    terminalRef.current?.reset();

    // Request fresh history if connected
    if (connectedRef.current) {
      stateRef.current.historyRequested = true;
      stateRef.current.waitingForDiff = true;
      requestHistory(sessionId, workerId, 0);
    }
  }, [sessionId, workerId]);

  const { sendInput, sendResize, sendImage, connected, error } = useTerminalWebSocket(sessionId, workerId, {
    onOutput: handleOutput,
    onHistory: handleHistory,
    onExit: handleExit,
    onConnectionChange: handleConnectionChange,
    onActivity: handleActivity,
    onOutputTruncated: handleOutputTruncated,
  });

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

    // Mark as mounted for conditional rendering support
    stateRef.current.isMounted = true;
    // Store current worker ID for race condition detection
    stateRef.current.currentWorkerId = workerId;

    // Try to restore terminal state from cache before processing server history
    // This eliminates flickering when switching between workers
    loadTerminalState(sessionId, workerId)
      .then(async (cached) => {
        // Race condition check: abort if component unmounted or worker changed
        if (!stateRef.current.isMounted) {
          console.debug('[Terminal] Abandoned cache read: component unmounted for workerId:', workerId);
          return;
        }
        if (stateRef.current.currentWorkerId !== workerId) {
          console.debug('[Terminal] Abandoned cache read for stale workerId:', workerId);
          return;
        }
        // Skip if history was already requested (React Strict Mode double-mount)
        if (stateRef.current.historyRequested) {
          return;
        }

        // Use terminalRef.current instead of captured terminal variable
        // to handle React Strict Mode double-mounting
        const currentTerminal = terminalRef.current;
        if (cached && cached.data && currentTerminal) {
          // Restore cached terminal state
          currentTerminal.write(cached.data, () => {
            updateScrollButtonVisibility();
          });
          // Store the cached offset for diff request
          stateRef.current.cachedOffset = cached.offset;
          offsetRef.current = cached.offset;
          // Mark as restored to skip full server history (we'll request diff instead)
          stateRef.current.restoredFromCache = true;
          // Request diff: if already connected, send now; otherwise useEffect will handle it
          // Use connectedRef.current to get the latest connected value
          // Set waitingForDiff so handleHistory knows to process the response
          stateRef.current.waitingForDiff = true;
          if (connectedRef.current) {
            stateRef.current.historyRequested = true;
            requestHistory(sessionId, workerId, cached.offset);
          }
        } else {
          // No cache - request full history from server (fromOffset: 0)
          stateRef.current.cachedOffset = 0;
          // Request history: if already connected, send now; otherwise useEffect will handle it
          // Use connectedRef.current to get the latest connected value
          // Set waitingForDiff so handleHistory knows to process the response
          stateRef.current.waitingForDiff = true;
          if (connectedRef.current) {
            stateRef.current.historyRequested = true;
            requestHistory(sessionId, workerId, 0);
          }
        }
      })
      .catch((e) => {
        console.warn('[Terminal] Failed to load cached state:', e);
        setCacheError('Failed to load cached terminal state');

        // Race condition check: abort if component unmounted or worker changed
        if (!stateRef.current.isMounted) {
          console.debug('[Terminal] Abandoned cache read (error path): component unmounted for workerId:', workerId);
          return;
        }
        if (stateRef.current.currentWorkerId !== workerId) {
          console.debug('[Terminal] Abandoned cache read (error path) for stale workerId:', workerId);
          return;
        }
        // Skip if history was already requested
        if (stateRef.current.historyRequested) {
          return;
        }
        // Fallback: request full history from server
        stateRef.current.cachedOffset = 0;
        // Set waitingForDiff so handleHistory knows to process the response
        stateRef.current.waitingForDiff = true;
        if (connectedRef.current) {
          stateRef.current.historyRequested = true;
          requestHistory(sessionId, workerId, 0);
        }
      });

    // Delay fit to ensure container has dimensions
    const fitTerminal = () => {
      if (container.offsetHeight > 0 && container.offsetWidth > 0) {
        try {
          fitAddon.fit();
        } catch (e) {
          console.warn('Failed to fit terminal:', e);
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
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result as string;
            // Remove data URL prefix (e.g., "data:image/png;base64,")
            const base64Data = base64.split(',')[1];
            sendImage(base64Data, item.type);
          };
          reader.readAsDataURL(blob);
          return; // Only handle first image
        }
      }
      // If no image, let xterm handle normal text paste
    };

    container.addEventListener('paste', handlePaste);
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
      // Save terminal state to cache before unmounting
      // This enables instant restoration when switching back to this worker
      try {
        const serializedData = serializeAddon.serialize();
        saveTerminalState(sessionId, workerId, {
          data: serializedData,
          savedAt: Date.now(),
          cols: terminal.cols,
          rows: terminal.rows,
          offset: offsetRef.current,
        }).catch((e) => console.warn('[Terminal] Failed to save terminal state:', e));
      } catch (e) {
        console.warn('[Terminal] Failed to serialize terminal state:', e);
      }

      // Reset state for conditional rendering support
      stateRef.current = {
        isMounted: false,
        pendingHistory: null,
        restoredFromCache: false,
        waitingForDiff: false,
        cachedOffset: 0,
        historyRequested: false,
        currentWorkerId: '',
      };
      offsetRef.current = 0;

      cancelAnimationFrame(rafId);
      viewportObserver.disconnect();
      container.removeEventListener('paste', handlePaste);
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
  }, [sessionId, workerId, sendInput, sendResize, sendImage, updateScrollButtonVisibility]);

  // Send resize when connection is established
  useEffect(() => {
    if (connected && terminalRef.current && fitAddonRef.current) {
      fitAddonRef.current.fit();
      sendResize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [connected, sendResize]);

  // Request history when connection is established and we're waiting for it
  // This handles both: diff after cache restoration, and full history when no cache
  useEffect(() => {
    if (connected && stateRef.current.waitingForDiff && !stateRef.current.historyRequested) {
      // Request history with the appropriate offset
      // - cachedOffset > 0: diff request after cache restoration
      // - cachedOffset = 0: full history request (no cache)
      stateRef.current.historyRequested = true;
      // Note: waitingForDiff remains true so handleHistory processes the response correctly
      requestHistory(sessionId, workerId, stateRef.current.cachedOffset);
    }
  }, [connected, sessionId, workerId]);

  // Clean up visibility tracking on unmount to prevent stale reconnection
  useEffect(() => {
    return () => {
      clearVisibilityTracking(sessionId, workerId);
    };
  }, [sessionId, workerId]);

  // Clean up truncation warning timeout on unmount
  useEffect(() => {
    return () => {
      if (truncationTimeoutRef.current) {
        clearTimeout(truncationTimeoutRef.current);
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
          <div className="absolute inset-0 flex items-center justify-center bg-slate-800/90">
            <div className="bg-red-900/80 border border-red-700 rounded-lg p-6 max-w-md text-center">
              <div className="text-red-400 text-lg font-medium mb-2">Worker Error</div>
              <div className="text-gray-200">{workerError.message}</div>
            </div>
          </div>
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

  // Ignore callback reference changes (onStatusChange, onActivityChange)
  // These are likely recreated on parent re-render but functionally equivalent
  return true; // No meaningful change (skip re-render)
});
