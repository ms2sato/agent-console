import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useTerminalWebSocket, type WorkerError } from '../hooks/useTerminalWebSocket';
import * as workerWs from '../lib/worker-websocket.js';
import { clearAndWrite, isScrolledToBottom } from '../lib/terminal-utils.js';
import { calculateHistoryUpdate } from '../lib/terminal-history-utils.js';
import type { AgentActivityState } from '@agent-console/shared';
import { ChevronDownIcon } from './Icons';

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
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | null>(null);
  const [workerError, setWorkerError] = useState<WorkerError | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

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

  const handleScrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    setShowScrollButton(false);
  }, []);

  const handleOutput = useCallback((data: string) => {
    terminalRef.current?.write(data, () => {
      updateScrollButtonVisibility();
    });
  }, [updateScrollButtonVisibility]);

  const handleHistory = useCallback((data: string) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (!data) return;

    // Get lastHistoryData from worker-websocket (persists across tab switches)
    const lastHistoryData = workerWs.getLastHistoryData(sessionId, workerId);
    const update = calculateHistoryUpdate(lastHistoryData, data);

    // Update the cached history data in worker-websocket
    workerWs.setLastHistoryData(sessionId, workerId, data);

    // Handle different update types
    if (update.type === 'diff') {
      // Append-only update (tab switch) - write only the diff
      if (!update.newData) return; // No new content to write

      // Capture scroll state BEFORE async write
      // Check if user was at bottom - if so, let natural scroll happen after write
      let wasAtBottom = false;
      let scrollPosition = 0;
      try {
        wasAtBottom = isScrolledToBottom(terminal);
        if (!wasAtBottom) {
          scrollPosition = terminal.buffer.active.viewportY;
        }
      } catch (e) {
        console.warn('[Terminal] Failed to capture scroll position:', e);
      }

      try {
        terminal.write(update.newData, () => {
          // Only restore scroll position if user was NOT at bottom
          // If user was at bottom, let xterm's natural scroll behavior show new content
          if (!wasAtBottom) {
            try {
              const currentTerminal = terminalRef.current;
              if (currentTerminal) {
                // Validate scroll position is within valid range
                const maxScrollPosition = Math.max(0, currentTerminal.buffer.active.length - currentTerminal.rows);
                const safePosition = Math.min(scrollPosition, maxScrollPosition);
                currentTerminal.scrollToLine(safePosition);
              }
            } catch (e) {
              console.warn('[Terminal] Failed to restore scroll position:', e);
            }
          }
          updateScrollButtonVisibility();
        });
      } catch (e) {
        console.error('[Terminal] Failed to write history diff:', e);
      }
    } else {
      // Initial load or full rewrite - clear and write all data
      clearAndWrite(terminal, () => {
        return new Promise((resolve, reject) => {
          try {
            terminal.write(update.newData, resolve);
          } catch (e) {
            reject(e);
          }
        });
      })
        .then(() => {
          // Scroll to bottom only on initial load
          if (update.shouldScrollToBottom) {
            try {
              terminalRef.current?.scrollToBottom();
            } catch (e) {
              console.warn('[Terminal] Failed to scroll to bottom:', e);
            }
          }
          updateScrollButtonVisibility();
        })
        .catch((e) => console.error('[Terminal] Failed to write history:', e));
    }
  }, [sessionId, workerId, updateScrollButtonVisibility]);

  const handleExit = useCallback((exitCode: number, signal: string | null) => {
    setStatus('exited');
    setExitInfo({ code: exitCode, signal });
  }, []);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setStatus(connected ? 'connected' : 'disconnected');
  }, []);

  const handleActivity = useCallback((state: AgentActivityState) => {
    onActivityChange?.(state);
  }, [onActivityChange]);

  const { sendInput, sendResize, sendImage, connected, error } = useTerminalWebSocket(sessionId, workerId, {
    onOutput: handleOutput,
    onHistory: handleHistory,
    onExit: handleExit,
    onConnectionChange: handleConnectionChange,
    onActivity: handleActivity,
  });

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

    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

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
    const viewportElement = container.querySelector('.xterm-viewport');

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
        viewportListenerAdded = true;
        viewportObserver.disconnect(); // Stop observing once found
      }
    });

    viewportObserver.observe(container, {
      childList: true,
      subtree: true
    });

    // MutationObserver to watch for scroll-related attribute changes
    const mutationObserver = new MutationObserver(() => {
      updateScrollButtonVisibility();
    });
    mutationObserver.observe(container, {
      attributes: true,
      attributeFilter: ['scrollTop', 'scrollLeft'],
      subtree: true
    });

    // Polling fallback to detect scroll changes that other methods might miss
    let lastScrollTop = 0;
    const scrollCheckInterval = setInterval(() => {
      const viewport = container.querySelector('.xterm-viewport') as HTMLElement;
      if (viewport && viewport.scrollTop !== lastScrollTop) {
        lastScrollTop = viewport.scrollTop;
        updateScrollButtonVisibility();
      }
    }, 100);

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(scrollCheckInterval);
      viewportObserver.disconnect();
      mutationObserver.disconnect();
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
        terminal.dispose();
      }, 0);
    };
  }, [sendInput, sendResize, sendImage, updateScrollButtonVisibility]);

  // Send resize when connection is established
  useEffect(() => {
    if (connected && terminalRef.current && fitAddonRef.current) {
      fitAddonRef.current.fit();
      sendResize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [connected, sendResize]);

  // Clean up visibility tracking on unmount to prevent stale reconnection
  useEffect(() => {
    return () => {
      workerWs.clearVisibilityTracking(sessionId, workerId);
    };
  }, [sessionId, workerId]);

  const statusColor =
    workerError ? 'bg-red-500' :
    status === 'connected' ? 'bg-green-500' :
    status === 'connecting' ? 'bg-yellow-500' :
    status === 'exited' ? 'bg-red-500' : 'bg-gray-500';

  const getStatusText = () => {
    if (workerError) {
      return 'Error';
    }
    if (status === 'connecting') return 'Connecting...';
    if (status === 'connected') return 'Connected';
    if (status === 'disconnected') return 'Disconnected';
    if (status === 'exited') {
      return `Exited (code: ${exitInfo?.code}${exitInfo?.signal ? `, signal: ${exitInfo.signal}` : ''})`;
    }
    return '';
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {!hideStatusBar && (
        <div className="px-3 py-2 bg-slate-900 border-b border-gray-700 flex items-center gap-3 shrink-0">
          <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} />
          <span className="text-gray-500 text-sm">
            {getStatusText()}
          </span>
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
