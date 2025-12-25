/**
 * Utilities for handling terminal history updates
 */

export type HistoryUpdateType = 'initial' | 'diff' | 'full';

export interface HistoryUpdate {
  /**
   * Type of update to perform
   * - 'initial': First time loading (no previous history)
   * - 'diff': Append-only update (tab switch with new content)
   * - 'full': Complete rewrite (history changed, rare case)
   */
  type: HistoryUpdateType;
  /**
   * Data to write to terminal
   * - For 'initial' and 'full': complete history data
   * - For 'diff': only the new part (diff)
   */
  newData: string;
  /**
   * Whether to scroll to bottom after writing
   * - true for 'initial' (user wants to see latest content)
   * - false for 'diff' and 'full' (preserve scroll position)
   */
  shouldScrollToBottom: boolean;
}

/**
 * Determine how to update terminal based on previous and new history data
 *
 * @param lastHistoryData - Previously received history data (empty string if none)
 * @param newData - New history data from server
 * @returns Update instruction for terminal
 *
 * @example
 * // Initial load
 * calculateHistoryUpdate('', 'hello\nworld')
 * // => { type: 'initial', newData: 'hello\nworld', shouldScrollToBottom: true }
 *
 * @example
 * // Tab switch with new content (append-only)
 * calculateHistoryUpdate('hello\n', 'hello\nworld\n')
 * // => { type: 'diff', newData: 'world\n', shouldScrollToBottom: false }
 *
 * @example
 * // History changed (rare)
 * calculateHistoryUpdate('hello\nworld', 'goodbye')
 * // => { type: 'full', newData: 'goodbye', shouldScrollToBottom: false }
 */
export function calculateHistoryUpdate(
  lastHistoryData: string,
  newData: string
): HistoryUpdate {
  // Initial load - no previous history
  // Show everything and scroll to bottom (user wants to see latest content)
  if (!lastHistoryData) {
    return {
      type: 'initial',
      newData,
      shouldScrollToBottom: true,
    };
  }

  // Append-only update (typical tab switch scenario)
  // New data starts with previous data, meaning content was only appended
  // Show only the diff and preserve scroll position (user may be reading history)
  if (newData.startsWith(lastHistoryData)) {
    const diff = newData.slice(lastHistoryData.length);
    return {
      type: 'diff',
      newData: diff,
      shouldScrollToBottom: false,
    };
  }

  // History changed (rare case)
  // New data doesn't start with previous data, need complete rewrite
  // Preserve scroll position
  return {
    type: 'full',
    newData,
    shouldScrollToBottom: false,
  };
}
