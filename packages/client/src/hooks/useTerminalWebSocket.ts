import { useEffect, useRef, useCallback, useState } from 'react';
import type { TerminalClientMessage, TerminalServerMessage, ClaudeActivityState } from '@agents-web-console/shared';

interface UseTerminalWebSocketOptions {
  onOutput: (data: string) => void;
  onHistory: (data: string) => void;
  onExit: (exitCode: number, signal: string | null) => void;
  onConnectionChange: (connected: boolean) => void;
  onActivity?: (state: ClaudeActivityState) => void;
}

interface UseTerminalWebSocketReturn {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  sendImage: (data: string, mimeType: string) => void;
  connected: boolean;
}

export function useTerminalWebSocket(
  wsUrl: string,
  options: UseTerminalWebSocketOptions
): UseTerminalWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      optionsRef.current.onConnectionChange(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg: TerminalServerMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'output':
            optionsRef.current.onOutput(msg.data);
            break;
          case 'history':
            optionsRef.current.onHistory(msg.data);
            break;
          case 'exit':
            optionsRef.current.onExit(msg.exitCode, msg.signal);
            break;
          case 'activity':
            optionsRef.current.onActivity?.(msg.state);
            break;
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      optionsRef.current.onConnectionChange(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: TerminalClientMessage = { type: 'input', data };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: TerminalClientMessage = { type: 'resize', cols, rows };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendImage = useCallback((data: string, mimeType: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: TerminalClientMessage = { type: 'image', data, mimeType };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendInput, sendResize, sendImage, connected };
}
