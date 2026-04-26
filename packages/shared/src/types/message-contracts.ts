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
  create: (content: string): MessageContent => {
    // Normalize all newline variations to \n (soft newlines)
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n') as MessageContent
  },

  /**
   * Extract preserved content with normalized newlines.
   * Guarantees that \n characters represent content newlines, not operations.
   */
  preserveNewlines: (content: MessageContent): string => {
    // Normalize all newline variations to \n (soft newlines)
    return (content as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  },

  /**
   * Get raw content without any processing.
   * Use with caution - prefer preserveNewlines for most cases.
   */
  raw: (content: MessageContent): string => content as string,

  /**
   * Check if content is empty or whitespace-only.
   * Pure newlines are considered content, but mixed newlines+whitespace are empty.
   */
  isEmpty: (content: MessageContent): boolean => {
    const str = content as string
    // Empty string is empty
    if (str === '') return true

    // Check if it contains only newlines (no spaces/tabs)
    const onlyNewlines = /^[\n]*$/.test(str)
    if (onlyNewlines && str.length > 0) return false // Pure newlines = content

    // Otherwise check if it's only whitespace
    return str.trim().length === 0
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
 * MessageContent must not carry submit keystroke characters.
 */
export function isMessageContent(value: unknown): value is MessageContent {
  // MessageContent must not carry submit keystroke characters
  return typeof value === 'string' && !value.includes('\r')
}

/**
 * Type guard to check if a string represents a submit keystroke.
 */
export function isSubmitKeystroke(value: unknown): value is SubmitKeystroke {
  return typeof value === 'string' && value === '\r'
}