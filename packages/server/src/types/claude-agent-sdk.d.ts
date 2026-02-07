/**
 * Minimal type declarations for @anthropic-ai/claude-agent-sdk.
 * The actual package is dynamically imported at runtime.
 * These declarations allow TypeScript to compile without the package installed.
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  import type { UUID } from 'crypto';

  interface QueryOptions {
    cwd?: string;
    includePartialMessages?: boolean;
    abortController?: AbortController;
    permissionMode?: string;
    resume?: string;
    allowedTools?: string[];
    maxTurns?: number;
    model?: string;
    systemPrompt?: string;
    hooks?: Record<string, unknown>;
  }

  interface QueryInput {
    prompt: string;
    options?: QueryOptions;
  }

  function query(input: QueryInput): AsyncIterable<import('@agent-console/shared').SDKMessage>;

  /**
   * MessageParam type from @anthropic-ai/sdk/resources
   * Represents a conversation message with role and content.
   */
  type MessageParam = {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
  };

  /**
   * Content block types for MessageParam
   */
  type TextBlock = { type: 'text'; text: string };
  type ImageBlock = {
    type: 'image';
    source: {
      type: 'base64';
      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      data: string;
    };
  };
  type ToolUseBlock = {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  type ToolResultBlock = {
    type: 'tool_result';
    tool_use_id: string;
    content?: string | Array<TextBlock | ImageBlock>;
    is_error?: boolean;
  };
  type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

  /**
   * SDKUserMessage type - represents a user message in the SDK protocol.
   * This type is used for type compatibility checking with our valibot schema.
   */
  type SDKUserMessage = {
    type: 'user';
    message: MessageParam;
    parent_tool_use_id: string | null;
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    uuid?: UUID;
    session_id: string;
  };
}
