import { MessageContent, SubmitKeystroke, SubmitKeystrokeUtils } from '@agent-console/shared'
import { MessageContentProcessor } from './message-content-processor'

/**
 * Executes terminal operations with clear separation of concerns.
 *
 * Responsibility: Terminal operation execution
 * - Send message content to terminal (data)
 * - Execute submit operations (actions)
 * - Maintain clear separation between data and operations
 */
export class PTYOperationExecutor {
  /**
   * Inject message content and execute submit operation separately.
   * This is the correct pattern to prevent Issue #660 class of bugs.
   *
   * @param content - Message content to send (data)
   * @param ptyWrite - Function to write to PTY
   * @param shouldSubmit - Whether to execute submit operation
   */
  static injectMessage(
    content: MessageContent,
    ptyWrite: (data: string) => void,
    shouldSubmit: boolean = true
  ): void {
    // Validate content purity (no operations mixed in)
    MessageContentProcessor.validatePurity(content)

    // Validate PTY write function
    PTYOperationExecutor.validatePTYWrite(ptyWrite)

    // Step 1: Send message content (data)
    const preservedContent = MessageContentProcessor.extractContent(content)
    ptyWrite(preservedContent)

    // Step 2: Execute submit operation (action) - SEPARATELY
    if (shouldSubmit) {
      const submitKeystroke = PTYOperationExecutor.createSubmitOperation()
      PTYOperationExecutor.executeSubmit(submitKeystroke, ptyWrite)
    }
  }

  /**
   * Create a submit operation.
   * This is separate from content and represents a terminal action.
   */
  static createSubmitOperation(): SubmitKeystroke {
    return SubmitKeystrokeUtils.create()
  }

  /**
   * Execute submit keystroke operation.
   * This sends the actual submit signal to the terminal.
   */
  static executeSubmit(
    submitKeystroke: SubmitKeystroke,
    ptyWrite: (data: string) => void
  ): void {
    const keystroke = SubmitKeystrokeUtils.extract(submitKeystroke)
    ptyWrite(keystroke)
  }

  /**
   * Legacy method compatibility - converts old pattern to new separated pattern.
   * Use this to migrate from dangerous content.replace(/\r?\n/g, '\r') patterns.
   *
   * @deprecated Use injectMessage with proper separation instead
   */
  static migrateLegacyPattern(
    rawContent: string,
    ptyWrite: (data: string) => void
  ): void {
    // Convert legacy pattern to proper separation
    const content = MessageContentProcessor.process(rawContent)

    // Use proper separated injection
    PTYOperationExecutor.injectMessage(content, ptyWrite, true)
  }

  /**
   * Validate that a PTY write function is properly configured.
   */
  static validatePTYWrite(ptyWrite: unknown): void {
    if (typeof ptyWrite !== 'function') {
      throw new Error('PTY write function is required for operation execution')
    }
  }
}