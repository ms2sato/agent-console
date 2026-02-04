import { useState, useCallback, useRef, useEffect } from 'react';
import type { SDKMessage, AgentActivityState } from '@agent-console/shared';
import { useSdkWorkerWebSocket, type SdkWorkerError } from '../../hooks/useSdkWorkerWebSocket';
import { MessageInput } from '../sessions/MessageInput';

interface SdkWorkerViewProps {
  sessionId: string;
  workerId: string;
  onActivityChange?: (state: AgentActivityState) => void;
}

export function SdkWorkerView({ sessionId, workerId, onActivityChange }: SdkWorkerViewProps) {
  const [messages, setMessages] = useState<SDKMessage[]>([]);
  const [lastUuid, setLastUuid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<SdkWorkerError | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const historyRequestedRef = useRef(false);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Handle incoming message
  const handleMessage = useCallback((message: SDKMessage) => {
    setMessages(prev => [...prev, message]);
  }, []);

  // Handle message history
  const handleMessageHistory = useCallback((historyMessages: SDKMessage[], uuid: string | null) => {
    setMessages(historyMessages);
    setLastUuid(uuid);
  }, []);

  // Handle activity state changes
  const handleActivity = useCallback((state: AgentActivityState) => {
    // SDK worker is "sending" when it's actively working
    setSending(state === 'active');
    onActivityChange?.(state);
  }, [onActivityChange]);

  // Handle connection changes
  const handleConnectionChange = useCallback((isConnected: boolean) => {
    setConnected(isConnected);
  }, []);

  const { sendUserMessage, requestHistory, error: wsError } = useSdkWorkerWebSocket(
    sessionId,
    workerId,
    {
      onMessage: handleMessage,
      onMessageHistory: handleMessageHistory,
      onActivity: handleActivity,
      onConnectionChange: handleConnectionChange,
    }
  );

  // Sync WebSocket error state
  useEffect(() => {
    setError(wsError);
  }, [wsError]);

  // Request history when first connected
  useEffect(() => {
    if (connected && !historyRequestedRef.current) {
      historyRequestedRef.current = true;
      requestHistory(lastUuid ?? undefined);
    }
  }, [connected, lastUuid, requestHistory]);

  // Auto-scroll when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle sending user message
  const handleSend = useCallback(async (content: string) => {
    if (!connected || sending) return;
    sendUserMessage(content);
    // setSending will be set to true via onActivity callback when SDK starts working
  }, [connected, sending, sendUserMessage]);

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-900">
      {/* Connection status indicator */}
      {!connected && (
        <div className="absolute top-2 right-2 px-3 py-1 bg-red-900/80 text-red-200 text-xs rounded z-10">
          Disconnected
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="bg-red-900/50 border-b border-red-700 px-4 py-2 text-red-300 text-sm">
          <span className="font-medium">Error:</span> {error.message}
          {error.code && <span className="text-red-400 ml-2">({error.code})</span>}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {connected ? 'No messages yet. Send a message to start.' : 'Connecting...'}
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((msg, index) => renderMessage(msg, index))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <MessageInput
        onSend={handleSend}
        placeholder="Send message to SDK worker... (Ctrl+Enter to send)"
        disabled={!connected}
        sending={sending}
      />
    </div>
  );
}

/**
 * Render a single SDK message.
 * For MVP, we use simple formatting with JSON display.
 * This can be enhanced later with proper message type rendering.
 */
function renderMessage(msg: SDKMessage, index: number): React.ReactNode {
  // Skip stream events for cleaner display
  if (msg.type === 'stream_event') {
    return null;
  }

  // Determine message styling based on type
  const typeStyles = getTypeStyles(msg.type);

  return (
    <div key={msg.uuid ?? index} className="p-2 border-b border-slate-700">
      <div className={`text-xs mb-1 ${typeStyles.labelColor}`}>
        {msg.type}
        {msg.uuid && <span className="text-gray-600 ml-2">{msg.uuid.slice(0, 8)}...</span>}
      </div>
      <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words overflow-x-auto bg-slate-800 p-2 rounded">
        {JSON.stringify(msg, null, 2)}
      </pre>
    </div>
  );
}

/**
 * Get styling based on message type.
 */
function getTypeStyles(type: string): { labelColor: string } {
  switch (type) {
    case 'user':
      return { labelColor: 'text-blue-400' };
    case 'assistant':
      return { labelColor: 'text-green-400' };
    case 'result':
      return { labelColor: 'text-yellow-400' };
    case 'error':
      return { labelColor: 'text-red-400' };
    default:
      return { labelColor: 'text-gray-500' };
  }
}
