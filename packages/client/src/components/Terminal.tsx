import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useTerminalWebSocket, type WorkerError } from '../hooks/useTerminalWebSocket';
import * as workerWs from '../lib/worker-websocket.js';
import { clearAndWrite } from '../lib/terminal-utils.js';
import type { AgentActivityState } from '@agent-console/shared';

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
  const hasRestoredSnapshotRef = useRef(false);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [exitInfo, setExitInfo] = useState<{ code: number; signal: string | null } | null>(null);
  const [workerError, setWorkerError] = useState<WorkerError | null>(null);

  // Notify parent of status changes
  useEffect(() => {
    onStatusChange?.(status, exitInfo ?? undefined);
  }, [status, exitInfo, onStatusChange]);

  const handleOutput = useCallback((data: string) => {
    terminalRef.current?.write(data);
  }, []);

  const handleHistory = useCallback((data: string, offset?: number) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // Store the offset for future visibility-based reconnection
    if (offset !== undefined) {
      workerWs.storeHistoryOffset(sessionId, workerId, offset);
    }

    // Only consume snapshot on first history message after reconnect
    if (!hasRestoredSnapshotRef.current) {
      const snapshot = workerWs.consumeSnapshot(sessionId, workerId);
      if (snapshot) {
        // Only set the flag after successfully consuming snapshot
        hasRestoredSnapshotRef.current = true;
        clearAndWrite(terminal, () => {
          return new Promise((resolve, reject) => {
            try {
              if (data) {
                terminal.write(snapshot);
                terminal.write(data, resolve);
              } else {
                terminal.write(snapshot, resolve);
              }
            } catch (e) {
              reject(e);
            }
          });
        }).catch((e) => console.error('[Terminal] Failed to restore snapshot:', e));
        return;
      }
      // If no snapshot available, mark as restored to avoid re-checking
      hasRestoredSnapshotRef.current = true;
    }

    // Normal history handling (no snapshot)
    if (data) {
      clearAndWrite(terminal, () => {
        return new Promise((resolve, reject) => {
          try {
            terminal.write(data, resolve);
          } catch (e) {
            reject(e);
          }
        });
      }).catch((e) => console.error('[Terminal] Failed to write history:', e));
    }
  }, [sessionId, workerId]);

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
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank');
    });
    terminal.loadAddon(webLinksAddon);

    // Enable terminal serialization for snapshot/restore on visibility change
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);

    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

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
    requestAnimationFrame(fitTerminal);

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

    return () => {
      container.removeEventListener('paste', handlePaste);
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
    };
  }, [sendInput, sendResize, sendImage]);

  // Send resize when connection is established
  useEffect(() => {
    if (connected && terminalRef.current && fitAddonRef.current) {
      fitAddonRef.current.fit();
      sendResize(terminalRef.current.cols, terminalRef.current.rows);
    }
  }, [connected, sendResize]);

  // Register snapshot callback with worker-websocket for visibility-based serialization
  // This ensures snapshot is captured BEFORE WebSocket is closed (fixes race condition)
  useEffect(() => {
    const snapshotCallback = () => {
      const serializeAddon = serializeAddonRef.current;
      if (serializeAddon) {
        try {
          const snapshot = serializeAddon.serialize();
          if (snapshot && snapshot.length > 0) {
            workerWs.storeSnapshot(sessionId, workerId, snapshot);
          }
        } catch (error) {
          console.error('[Terminal] Failed to serialize snapshot:', error);
        }
      }
    };

    workerWs.registerSnapshotCallback(sessionId, workerId, snapshotCallback);

    return () => {
      workerWs.unregisterSnapshotCallback(sessionId, workerId);
      // Clear visibility tracking on unmount to prevent stale reconnection
      workerWs.clearVisibilityTracking(sessionId, workerId);
    };
  }, [sessionId, workerId]);

  // Handle visibility change to reset the snapshot restore flag when page becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Reset the flag so the next history message can potentially use a snapshot
        hasRestoredSnapshotRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

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
      </div>
    </div>
  );
}
