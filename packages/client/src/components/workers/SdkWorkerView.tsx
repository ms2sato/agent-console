import { useState, useCallback, useRef, useEffect } from 'react';
import type { SDKMessage, AgentActivityState } from '@agent-console/shared';
import { useSdkWorkerWebSocket, type SdkWorkerError } from '../../hooks/useSdkWorkerWebSocket';
import { MessageInput } from '../sessions/MessageInput';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'exited';

// Type definitions for SDK message content
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | { type: string };

interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ResultMessage extends SDKMessage {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface SystemInitMessage extends SDKMessage {
  type: 'system';
  subtype?: string;
  session_id?: string;
  model?: string;
}

interface SdkWorkerViewProps {
  sessionId: string;
  workerId: string;
  onActivityChange?: (state: AgentActivityState) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export function SdkWorkerView({ sessionId, workerId, onActivityChange, onStatusChange }: SdkWorkerViewProps) {
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
    onStatusChange?.(isConnected ? 'connected' : 'disconnected');
  }, [onStatusChange]);

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
 * Render a single SDK message with appropriate formatting based on type.
 */
function renderMessage(msg: SDKMessage, index: number): React.ReactNode {
  // Skip stream events for cleaner display
  if (msg.type === 'stream_event') {
    return null;
  }

  const key = msg.uuid ?? index;

  switch (msg.type) {
    case 'user':
      return <UserMessage key={key} msg={msg} />;
    case 'assistant':
      return <AssistantMessageView key={key} msg={msg} />;
    case 'result':
      return <ResultMessageView key={key} msg={msg as ResultMessage} />;
    case 'system':
      return <SystemMessageView key={key} msg={msg as SystemInitMessage} />;
    default:
      // Fallback for unknown message types
      return (
        <div key={key} className="p-2 text-xs text-gray-500">
          <details>
            <summary className="cursor-pointer hover:text-gray-400">
              {msg.type} message
            </summary>
            <pre className="mt-1 text-gray-600 whitespace-pre-wrap break-words">
              {JSON.stringify(msg, null, 2)}
            </pre>
          </details>
        </div>
      );
  }
}

/**
 * Render user message - right-aligned with blue styling
 */
function UserMessage({ msg }: { msg: SDKMessage }) {
  // User messages have content in a nested message object or as direct content
  const content = extractUserContent(msg);

  return (
    <div className="flex justify-end mb-3">
      <div className="max-w-[80%] bg-blue-600 text-white rounded-lg px-4 py-2">
        <FormattedText text={content} />
      </div>
    </div>
  );
}

/**
 * Extract user message content from various formats
 */
function extractUserContent(msg: SDKMessage): string {
  // Try message.content first (API format)
  if (msg.message && typeof msg.message === 'object') {
    const message = msg.message as { content?: unknown };
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return extractTextFromContentBlocks(message.content as ContentBlock[]);
    }
  }
  // Try direct content
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  // Fallback to JSON
  return JSON.stringify(msg, null, 2);
}

/**
 * Render assistant message - left-aligned with green accent
 */
function AssistantMessageView({ msg }: { msg: SDKMessage }) {
  const content = extractAssistantContent(msg);
  const toolUses = extractToolUses(msg);
  const usage = extractUsage(msg);

  return (
    <div className="mb-3">
      <div className="flex items-start gap-2">
        <div className="w-1 self-stretch bg-green-500 rounded-full shrink-0" />
        <div className="flex-1 min-w-0">
          {/* Main text content */}
          {content && (
            <div className="text-gray-200">
              <FormattedText text={content} />
            </div>
          )}

          {/* Tool uses */}
          {toolUses.length > 0 && (
            <div className="mt-2 space-y-1">
              {toolUses.map((tool, i) => (
                <div key={i} className="text-xs bg-slate-800 rounded px-2 py-1 text-gray-400">
                  <span className="text-purple-400">{tool.name}</span>
                  <details className="inline ml-2">
                    <summary className="cursor-pointer hover:text-gray-300">input</summary>
                    <pre className="mt-1 text-gray-500 whitespace-pre-wrap break-words overflow-x-auto">
                      {JSON.stringify(tool.input, null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}

          {/* Usage info (small) */}
          {usage && (
            <div className="mt-1 text-xs text-gray-600">
              {usage.input_tokens !== undefined && `in: ${usage.input_tokens}`}
              {usage.output_tokens !== undefined && ` / out: ${usage.output_tokens}`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Extract text content from assistant message
 */
function extractAssistantContent(msg: SDKMessage): string {
  if (msg.message && typeof msg.message === 'object') {
    const message = msg.message as AssistantMessage;
    if (Array.isArray(message.content)) {
      return extractTextFromContentBlocks(message.content);
    }
  }
  return '';
}

/**
 * Extract text from content blocks array
 */
function extractTextFromContentBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Extract tool uses from assistant message
 */
function extractToolUses(msg: SDKMessage): { name: string; input: unknown }[] {
  if (msg.message && typeof msg.message === 'object') {
    const message = msg.message as AssistantMessage;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block): block is ToolUseBlock => block.type === 'tool_use')
        .map(block => ({ name: block.name, input: block.input }));
    }
  }
  return [];
}

/**
 * Extract usage info from assistant message
 */
function extractUsage(msg: SDKMessage): { input_tokens?: number; output_tokens?: number } | null {
  if (msg.message && typeof msg.message === 'object') {
    const message = msg.message as AssistantMessage;
    if (message.usage) {
      return message.usage;
    }
  }
  return null;
}

/**
 * Render result message - compact summary
 */
function ResultMessageView({ msg }: { msg: ResultMessage }) {
  const isError = msg.is_error;
  const bgColor = isError ? 'bg-red-900/30' : 'bg-slate-800';
  const borderColor = isError ? 'border-red-700' : 'border-slate-700';

  return (
    <div className={`mb-3 p-2 rounded ${bgColor} border ${borderColor}`}>
      <div className="flex items-center justify-between text-xs">
        <span className={isError ? 'text-red-400' : 'text-yellow-400'}>
          {isError ? 'Error' : 'Completed'}
          {msg.subtype && ` (${msg.subtype})`}
        </span>
        <div className="flex gap-3 text-gray-500">
          {msg.num_turns !== undefined && (
            <span>{msg.num_turns} turn{msg.num_turns !== 1 ? 's' : ''}</span>
          )}
          {msg.duration_ms !== undefined && (
            <span>{(msg.duration_ms / 1000).toFixed(1)}s</span>
          )}
          {msg.total_cost_usd !== undefined && (
            <span>${msg.total_cost_usd.toFixed(4)}</span>
          )}
        </div>
      </div>
      {msg.usage && (
        <div className="text-xs text-gray-600 mt-1">
          Tokens: {msg.usage.input_tokens ?? 0} in / {msg.usage.output_tokens ?? 0} out
        </div>
      )}
    </div>
  );
}

/**
 * Render system message - collapsible
 */
function SystemMessageView({ msg }: { msg: SystemInitMessage }) {
  return (
    <div className="mb-2 text-xs">
      <details>
        <summary className="cursor-pointer text-gray-500 hover:text-gray-400">
          System: {msg.subtype ?? 'init'}
          {msg.model && <span className="ml-2 text-gray-600">({msg.model})</span>}
        </summary>
        <div className="mt-1 pl-4 text-gray-600">
          {msg.session_id && <div>Session: {msg.session_id}</div>}
          <details className="mt-1">
            <summary className="cursor-pointer hover:text-gray-500">Full details</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words overflow-x-auto">
              {JSON.stringify(msg, null, 2)}
            </pre>
          </details>
        </div>
      </details>
    </div>
  );
}

/**
 * Format text with basic support for code blocks and line breaks.
 * This is a simple implementation - not full Markdown.
 */
function FormattedText({ text }: { text: string }) {
  // Split by code blocks (```...```)
  const parts = text.split(/(```[\s\S]*?```)/);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          // Code block
          const content = part.slice(3, -3);
          // Extract language hint if present
          const newlineIndex = content.indexOf('\n');
          const hasLang = newlineIndex > 0 && newlineIndex < 20 && !content.slice(0, newlineIndex).includes(' ');
          const lang = hasLang ? content.slice(0, newlineIndex) : '';
          const code = hasLang ? content.slice(newlineIndex + 1) : content;

          return (
            <pre key={i} className="my-2 p-2 bg-slate-900 rounded text-sm overflow-x-auto">
              {lang && <div className="text-xs text-gray-500 mb-1">{lang}</div>}
              <code className="text-gray-300">{code}</code>
            </pre>
          );
        }

        // Regular text - preserve line breaks
        return (
          <span key={i} className="whitespace-pre-wrap break-words">
            {part}
          </span>
        );
      })}
    </>
  );
}
