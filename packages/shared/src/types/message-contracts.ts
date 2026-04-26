/**
 * Message Content Semantic Contracts
 *
 * Prevents Issue #660 class of bugs by enforcing clear separation between:
 * - Message content (data to preserve)
 * - Terminal operations (actions to execute)
 *
 * @contract
 * - `\n` = soft newline (preserve in message content)
 * - `\r` = submit keystroke (separate terminal operation)
 * - NEVER convert message newlines to submit keystrokes
 */

/**
 * Represents message content that preserves semantic meaning of newlines.
 * Newlines in MessageContent are data to be preserved, not operations.
 */
export type MessageContent = string & { readonly __brand: 'MessageContent' }

/**
 * Represents a terminal submit keystroke operation.
 * This is an operation to execute, not data content.
 */
export type SubmitKeystroke = string & { readonly __brand: 'SubmitKeystroke' }

/**
 * Factory and utility functions for MessageContent.
 */
export const MessageContentUtils = {
  /**
   * Create MessageContent from raw string input.
   * Ensures all newlines are preserved as soft newlines (\n).
   */
  create: (content: string): MessageContent => content as MessageContent,

  /**
   * Extract preserved content with normalized newlines.
   * Guarantees that \n characters represent content newlines, not operations.
   */
  preserveNewlines: (content: MessageContent): string => {
    // Normalize all newline variations to \n (soft newlines)
    return (content as string).replace(/\r?\n/g, '\n')
  },

  /**
   * Get raw content without any processing.
   * Use with caution - prefer preserveNewlines for most cases.
   */
  raw: (content: MessageContent): string => content as string,

  /**
   * Check if content is empty or whitespace-only.
   */
  isEmpty: (content: MessageContent): boolean => {
    return (content as string).trim().length === 0
  }
}

/**
 * Factory functions for SubmitKeystroke operations.
 */
export const SubmitKeystrokeUtils = {
  /**
   * Create a terminal submit keystroke.
   * This represents an operation to submit/execute, separate from content.
   */
  create: (): SubmitKeystroke => '\r' as SubmitKeystroke,

  /**
   * Extract the keystroke for terminal injection.
   */
  extract: (keystroke: SubmitKeystroke): string => keystroke as string
}

/**
 * Type guard to check if a string represents message content.
 */
export function isMessageContent(value: unknown): value is MessageContent {
  return typeof value === 'string'
}

/**
 * Type guard to check if a string represents a submit keystroke.
 */
export function isSubmitKeystroke(value: unknown): value is SubmitKeystroke {
  return typeof value === 'string' && value === '\r'
}