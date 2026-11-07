/** Longest instruction excerpt carried in a notification field, in characters (code points). */
export const INSTRUCTION_EXCERPT_MAX_CHARS = 120;

/**
 * The one-line cue for an operator instruction: its first non-empty line, cut
 * to {@link INSTRUCTION_EXCERPT_MAX_CHARS} code points (a surrogate pair is
 * never split). Single writer: the action half that fills the event metadata
 * and the notification renderer both call this, so the cap and the
 * "first non-empty line" rule cannot drift apart. Returns '' when the text has
 * no non-empty line.
 */
export function toInstructionExcerpt(instructionText: string): string {
  const firstLine = instructionText.split(/\r\n|\r|\n/).find((line) => line.trim().length > 0) ?? '';
  return Array.from(firstLine.trim()).slice(0, INSTRUCTION_EXCERPT_MAX_CHARS).join('');
}
