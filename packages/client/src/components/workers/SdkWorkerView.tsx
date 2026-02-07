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

  const { sendUserMessage, cancelQuery, requestHistory, error: wsError } = useSdkWorkerWebSocket(
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
            {renderGroupedMessages(messages, sending)}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <MessageInput
        onSend={handleSend}
        onStop={cancelQuery}
        placeholder="Send message to SDK worker... (Ctrl+Enter to send)"
        disabled={!connected}
        sending={sending}
      />
    </div>
  );
}

/**
 * Group messages into conversation turns and render them.
 * Each turn: user message → assistant messages (processing) → result
 * All processing steps within a turn are grouped into a single collapsible section.
 */
function renderGroupedMessages(messages: SDKMessage[], isProcessing: boolean): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let i = 0;

  // Find the last user message index to determine which turn is "current"
  let lastUserMessageIndex = -1;
  for (let j = messages.length - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.type === 'user' && !isToolResultMessage(m)) {
      const content = extractUserContent(m);
      if (content.trim()) {
        lastUserMessageIndex = j;
        break;
      }
    }
  }

  while (i < messages.length) {
    const msg = messages[i];

    // Skip stream events
    if (msg.type === 'stream_event') {
      i++;
      continue;
    }

    // Handle system messages independently
    if (msg.type === 'system') {
      result.push(<SystemMessageView key={msg.uuid ?? i} msg={msg as SystemInitMessage} />);
      i++;
      continue;
    }

    // Handle user messages - start of a conversation turn
    if (msg.type === 'user') {
      // Skip tool result messages
      if (isToolResultMessage(msg)) {
        i++;
        continue;
      }
      // Skip empty user messages
      const content = extractUserContent(msg);
      if (!content.trim()) {
        i++;
        continue;
      }

      // Track if this is the last (current) user message turn
      const isCurrentTurn = i === lastUserMessageIndex;

      // Render user message
      result.push(<UserMessage key={msg.uuid ?? `user-${i}`} msg={msg} />);
      i++;

      // Collect all assistant messages until result or next real user message
      // Skip system messages, tool result user messages, and stream events
      const assistantMessages: SDKMessage[] = [];
      const interstitialSystemMessages: SDKMessage[] = [];
      while (i < messages.length) {
        const nextMsg = messages[i];
        if (nextMsg.type === 'assistant') {
          assistantMessages.push(nextMsg);
          i++;
        } else if (nextMsg.type === 'user' && isToolResultMessage(nextMsg)) {
          // Skip tool result user messages
          i++;
        } else if (nextMsg.type === 'stream_event') {
          i++;
        } else if (nextMsg.type === 'system') {
          // Collect system messages that appear during the turn
          interstitialSystemMessages.push(nextMsg);
          i++;
        } else if (nextMsg.type === 'user') {
          // Real user message - check if it's empty
          const content = extractUserContent(nextMsg);
          if (!content.trim()) {
            i++;
            continue;
          }
          break; // Non-empty user message ends this turn
        } else {
          break;
        }
      }

      // Render any system messages that appeared during processing (usually none)
      for (const sysMsg of interstitialSystemMessages) {
        result.push(<SystemMessageView key={sysMsg.uuid ?? `sys-${result.length}`} msg={sysMsg as SystemInitMessage} />);
      }

      // Check if this turn has a result
      const hasResult = i < messages.length && messages[i].type === 'result';

      // Mark as "in progress" only if:
      // 1. This is the current (last) turn
      // 2. We're actively processing
      // 3. This turn has no result yet
      const turnInProgress = isCurrentTurn && isProcessing && !hasResult;

      if (assistantMessages.length > 0) {
        result.push(
          <GroupedAssistantResponse
            key={`response-${msg.uuid ?? i}`}
            assistantMessages={assistantMessages}
            inProgress={turnInProgress}
          />
        );
      } else if (turnInProgress) {
        // No assistant messages yet but we're processing - show processing indicator
        result.push(<ProcessingIndicator key={`processing-${msg.uuid ?? i}`} />);
      }

      // Render result message if present
      if (hasResult) {
        result.push(<ResultMessageView key={messages[i].uuid ?? `result-${i}`} msg={messages[i] as ResultMessage} />);
        i++;
      }

      continue;
    }

    // Handle orphan assistant messages (no preceding user message)
    if (msg.type === 'assistant') {
      result.push(
        <GroupedAssistantResponse
          key={`orphan-${msg.uuid ?? i}`}
          assistantMessages={[msg]}
        />
      );
      i++;
      continue;
    }

    // Handle orphan result messages
    if (msg.type === 'result') {
      result.push(<ResultMessageView key={msg.uuid ?? i} msg={msg as ResultMessage} />);
      i++;
      continue;
    }

    // Fallback for unknown message types
    result.push(
      <div key={msg.uuid ?? i} className="p-2 text-xs text-gray-500">
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
    i++;
  }

  return result;
}

/**
 * Processing indicator shown when waiting for assistant response
 */
function ProcessingIndicator() {
  return (
    <div className="mb-3">
      <div className="flex items-start gap-2">
        <div className="w-1 self-stretch bg-green-500 rounded-full shrink-0 animate-pulse" />
        <div className="flex-1 min-w-0">
          <div className="text-xs bg-slate-800/50 rounded border border-slate-700 px-2 py-1 text-gray-500 flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
            <span>Processing...</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Render grouped assistant response - combines all assistant messages into one view
 * with a single collapsible Processing section and the final text answer.
 */
function GroupedAssistantResponse({ assistantMessages, inProgress = false }: { assistantMessages: SDKMessage[]; inProgress?: boolean }) {
  // Collect all processing steps from all assistant messages
  const allThinkingBlocks: string[] = [];
  const allToolUses: { name: string; input: unknown }[] = [];
  const textParts: string[] = [];

  for (const msg of assistantMessages) {
    allThinkingBlocks.push(...extractThinkingBlocks(msg));
    allToolUses.push(...extractToolUses(msg));
    const text = extractAssistantContent(msg);
    if (text.trim()) {
      textParts.push(text);
    }
  }

  const hasProcessing = allThinkingBlocks.length > 0 || allToolUses.length > 0;
  const finalText = textParts.join('\n\n');
  const hasTextContent = finalText.trim().length > 0;

  // Build processing summary
  const processingSummary = buildProcessingSummary(allThinkingBlocks, allToolUses);

  return (
    <div className="mb-3">
      <div className="flex items-start gap-2">
        <div className={`w-1 self-stretch bg-green-500 rounded-full shrink-0 ${inProgress ? 'animate-pulse' : ''}`} />
        <div className="flex-1 min-w-0">
          {/* Single Processing section for ALL intermediate steps */}
          {hasProcessing && (
            <details className="mb-2 text-xs bg-slate-800/50 rounded border border-slate-700">
              <summary className="cursor-pointer px-2 py-1 text-gray-500 hover:text-gray-400 select-none flex items-center gap-2">
                {inProgress && (
                  <span className="inline-block w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                )}
                <span>{processingSummary}{inProgress ? '...' : ''}</span>
              </summary>
              <div className="px-2 py-1 border-t border-slate-700 space-y-2 max-h-60 overflow-y-auto">
                {/* Thinking blocks */}
                {allThinkingBlocks.map((thinking, i) => (
                  <div key={`thinking-${i}`} className="text-gray-400">
                    <div className="text-gray-500 text-[10px] uppercase tracking-wide mb-1">Thinking</div>
                    <div className="whitespace-pre-wrap break-words">{thinking}</div>
                  </div>
                ))}
                {/* Tool uses */}
                {allToolUses.map((tool, i) => (
                  <div key={`tool-${i}`}>
                    <div className="flex items-center gap-2 text-gray-500 text-[10px] uppercase tracking-wide mb-1">
                      <span className="text-purple-400">{tool.name}</span>
                      {getToolSummary(tool.name, tool.input) && (
                        <span className="normal-case text-gray-600">{getToolSummary(tool.name, tool.input)}</span>
                      )}
                    </div>
                    <pre className="text-gray-500 whitespace-pre-wrap break-words text-[11px]">
                      {JSON.stringify(tool.input, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Final text content - always visible */}
          {hasTextContent && (
            <div className="text-gray-200">
              <FormattedText text={finalText} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Check if a user message is a tool result (not actual user input)
 */
function isToolResultMessage(msg: SDKMessage): boolean {
  // Check for parent_tool_use_id (indicates this is a response to a tool)
  if ('parent_tool_use_id' in msg && msg.parent_tool_use_id !== null) {
    return true;
  }
  // Check for tool_use_result field
  if ('tool_use_result' in msg && msg.tool_use_result !== undefined) {
    return true;
  }
  // Check if message content contains tool_result blocks
  if (msg.message && typeof msg.message === 'object') {
    const message = msg.message as { content?: unknown };
    if (Array.isArray(message.content)) {
      return message.content.some((block: unknown) =>
        typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result'
      );
    }
  }
  return false;
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
 * Build a summary string for the processing section header
 */
function buildProcessingSummary(thinkingBlocks: string[], toolUses: { name: string; input: unknown }[]): string {
  const parts: string[] = [];

  if (thinkingBlocks.length > 0) {
    parts.push('Thinking');
  }

  // Count tool uses by name
  const toolCounts = new Map<string, number>();
  for (const tool of toolUses) {
    toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);
  }

  for (const [name, count] of toolCounts) {
    parts.push(count > 1 ? `${name}×${count}` : name);
  }

  return parts.length > 0 ? `Processing: ${parts.join(', ')}` : 'Processing...';
}


/**
 * Get a brief summary for a tool use
 */
function getToolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Bash':
      return typeof inp.command === 'string' ? truncate(inp.command, 50) : '';
    case 'Read':
      return typeof inp.file_path === 'string' ? truncate(inp.file_path, 50) : '';
    case 'Write':
    case 'Edit':
      return typeof inp.file_path === 'string' ? truncate(inp.file_path, 50) : '';
    case 'Glob':
      return typeof inp.pattern === 'string' ? truncate(inp.pattern, 40) : '';
    case 'Grep':
      return typeof inp.pattern === 'string' ? truncate(inp.pattern, 40) : '';
    default:
      return '';
  }
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Extract thinking blocks from assistant message
 */
function extractThinkingBlocks(msg: SDKMessage): string[] {
  if (msg.message && typeof msg.message === 'object') {
    const message = msg.message as AssistantMessage;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block): block is ThinkingBlock => block.type === 'thinking')
        .map(block => block.thinking);
    }
  }
  return [];
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
