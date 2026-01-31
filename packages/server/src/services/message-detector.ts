/**
 * MessageDetector - Scans agent worker output for inter-worker message patterns.
 *
 * Detects: <<<TO:worker-name>>>message<<<END>>>
 * The pattern may span multiple output chunks, so we buffer incomplete patterns.
 *
 * ANSI escape sequences are stripped before pattern matching since PTY output
 * contains terminal control codes that would interfere with delimiter detection.
 */

// Same ANSI regex used by activity-detector.ts
// Uses RegExp constructor to avoid raw ESC control character in source
const ANSI_REGEX = new RegExp(
  '\\x1B(?:[@-Z\\\\\\-_]|\\[[0-?]{0,16}[ -/]{0,4}[@-~])',
  'g'
);

const MESSAGE_PATTERN = /<<<TO:([^>]+)>>>([\s\S]*?)<<<END>>>/g;

export interface DetectedMessage {
  targetWorkerName: string;
  content: string;
}

export class MessageDetector {
  private buffer: string = '';
  private readonly maxBufferSize: number;

  constructor(maxBufferSize = 4096) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Process new output data and extract any complete messages.
   * Returns array of detected messages (may be empty).
   */
  processOutput(data: string): DetectedMessage[] {
    // Strip ANSI escape sequences before buffering
    const cleanData = data.replace(ANSI_REGEX, '');
    this.buffer += cleanData;

    // Trim buffer if too large (keep tail to avoid losing partial patterns)
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.maxBufferSize);
    }

    const messages: DetectedMessage[] = [];
    let lastIndex = 0;

    // Reset regex state
    MESSAGE_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = MESSAGE_PATTERN.exec(this.buffer)) !== null) {
      messages.push({
        targetWorkerName: match[1].trim(),
        content: match[2].trim(),
      });
      lastIndex = MESSAGE_PATTERN.lastIndex;
    }

    if (messages.length > 0) {
      // Remove processed content from buffer, keep remainder
      this.buffer = this.buffer.slice(lastIndex);
    }

    // If buffer has no opening delimiter at all, clear it to prevent unbounded growth
    // But keep content after the last <<<TO: in case it's a partial pattern
    const lastOpenIdx = this.buffer.lastIndexOf('<<<TO:');
    if (lastOpenIdx === -1) {
      this.buffer = '';
    } else if (lastOpenIdx > 0) {
      this.buffer = this.buffer.slice(lastOpenIdx);
    }

    return messages;
  }

  dispose(): void {
    this.buffer = '';
  }
}
