import { MessageContent, MessageContentUtils } from '@agent-console/shared'

/**
 * Handles message content processing with semantic newline preservation.
 *
 * Responsibility: Data processing and preservation
 * - Preserve message content integrity
 * - Normalize newlines as soft newlines (\n)
 * - NEVER convert content to terminal operations
 */
export class MessageContentProcessor {
  /**
   * Process raw input into semantic message content.
   * Preserves all newlines as content, not operations.
   */
  static process(rawInput: string): MessageContent {
    // Create semantic message content
    const content = MessageContentUtils.create(rawInput)
    return content
  }

  /**
   * Extract processed content with preserved newlines.
   * All newlines remain as content (\n), never operations (\r).
   */
  static extractContent(content: MessageContent): string {
    return MessageContentUtils.preserveNewlines(content)
  }

  /**
   * Validate that content has no submit operations mixed in.
   * Throws if content contains terminal operation characters.
   */
  static validatePurity(content: MessageContent): void {
    const raw = MessageContentUtils.raw(content)

    if (raw.includes('\r')) {
      throw new Error(
        'Contract violation: MessageContent contains submit keystroke (\\r). ' +
        'Message content and terminal operations must be separated. ' +
        'See Issue #660 prevention.'
      )
    }
  }

  /**
   * Check if content should be processed (not empty/whitespace-only).
   */
  static shouldProcess(content: MessageContent): boolean {
    return !MessageContentUtils.isEmpty(content)
  }
}