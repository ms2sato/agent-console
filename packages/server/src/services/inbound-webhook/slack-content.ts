/**
 * Text-only projection of a Slack message's Block Kit content into the `## Content` section of
 * `body.md`. The message is the version 1 `slack_message` or the version 2 `source.event`; this file
 * says `slack_message` for either.
 *
 * Only strings found in the positions the design doc's projection table lists are written; every
 * other key of the untrusted `slack_message` (user, `block_id`, URLs, image fields, action values,
 * `slack_message.text` itself) is never read. The one exception is the poster identity
 * (`app_id`, `bot_id`, top level), which {@link readPosterIdentity} shape-validates. The text is displayed as sent: no
 * entity decoding, no rewriting of Slack tokens, and nothing is derived from it (no counts of
 * findings, no severity, no routing).
 *
 * Every untrusted value is read through a non-strict valibot schema (`safeParse`), each block and
 * each attachment on its own, so one malformed entry is counted as "not shown" and never fails the
 * delivery. Nothing here logs or puts a payload string into an error message.
 */
import * as v from 'valibot';
import { stripControlChars } from '../../lib/pty-notification.js';

/** Largest projected text, in UTF-8 bytes. A constant, not configuration. */
export const SLACK_CONTENT_MAX_BYTES = 65536;

const SECTION_HEADING = '## Content';
const READING_NOTE =
  'Slack mrkdwn, verbatim. &lt; &gt; &amp; are escaped characters; <!channel>, <@U...> and <url|label> are Slack tokens.';
const CUT_NOTICE = `(Content cut at ${SLACK_CONTENT_MAX_BYTES} bytes.)`;
const SENDER_TRUNCATED_NOTICE =
  '(The sender shortened the Slack message to fit its size limit; content may be missing.)';

export interface SlackContentCounts {
  /** Entries of `slack_message.blocks` (top level), whatever their shape. */
  blocksSeen: number;
  /** Entries of `slack_message.attachments`, whatever their shape. */
  attachmentsSeen: number;
  /** Projected chunks (one per rendered block or attachment), before any cut. */
  chunks: number;
  /** Blocks and attachments that were counted as not shown. */
  notShown: number;
  /** Whether the projected text was cut at {@link SLACK_CONTENT_MAX_BYTES}. */
  cut: boolean;
}

export interface SlackContentProjection {
  /** The lines of the `## Content` section including its heading, or null when no section is rendered. */
  section: string[] | null;
  /** The first non-empty projected content line (a divider is not a line), or null. */
  firstLine: string | null;
  counts: SlackContentCounts;
}

/** Strip terminal-interpreted control characters, collapse whitespace to single spaces, trim. */
export function toSingleLine(value: string): string {
  return stripControlChars(value).replace(/\s+/g, ' ').trim();
}

/** Keep \n and \t; drop every other control character, including vertical tab and form feed. */
export function sanitizeMultiline(value: string): string {
  return stripControlChars(value).replace(/[\r\v\f]/g, '');
}

// ---------------------------------------------------------------------------
// Untrusted-value readers (non-strict: unknown keys and wrong-typed optional keys are ignored)
// ---------------------------------------------------------------------------

const TextObjectSchema = v.object({ text: v.string() });
const StringSchema = v.string();
const UnknownListSchema = v.array(v.unknown());

const BlockSchema = v.object({
  type: v.string(),
  text: v.optional(v.unknown()),
  fields: v.optional(v.unknown()),
  elements: v.optional(v.unknown()),
});

const AttachmentFieldSchema = v.object({
  title: v.optional(v.unknown()),
  value: v.optional(v.unknown()),
});

const AttachmentSchema = v.object({
  pretext: v.optional(v.unknown()),
  title: v.optional(v.unknown()),
  text: v.optional(v.unknown()),
  fields: v.optional(v.unknown()),
  blocks: v.optional(v.unknown()),
  fallback: v.optional(v.unknown()),
});

function stringOf(value: unknown): string | null {
  const parsed = v.safeParse(StringSchema, value);
  return parsed.success ? parsed.output : null;
}

/** The `text` of a text object (any object whose `text` is a string); null otherwise. */
function textOf(value: unknown): string | null {
  const parsed = v.safeParse(TextObjectSchema, value);
  return parsed.success ? parsed.output.text : null;
}

function listOf(value: unknown): unknown[] {
  const parsed = v.safeParse(UnknownListSchema, value);
  return parsed.success ? parsed.output : [];
}

/** A sanitized multi-line string, or null when it is absent or blank. */
function cleanText(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = sanitizeMultiline(value);
  return cleaned.trim() === '' ? null : cleaned;
}

function cleanTexts(values: Array<string | null>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (cleaned !== null) out.push(cleaned);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Poster identity
// ---------------------------------------------------------------------------

/** A poster id as received: upper-case letters and digits, 1 to 32 characters. No trim, no case folding. */
const PosterIdSchema = v.pipe(v.string(), v.regex(/^[A-Z0-9]{1,32}$/));

/** `absent`: the key is not there. `rejected`: it is there and fails the shape. */
export type PosterId = { kind: 'shown'; value: string } | { kind: 'absent' } | { kind: 'rejected' };

export interface PosterIdentity {
  appId: PosterId;
  botId: PosterId;
}

function readPosterId(message: Record<string, unknown> | undefined, key: 'app_id' | 'bot_id'): PosterId {
  try {
    const value = message?.[key];
    if (value === undefined) return { kind: 'absent' };
    const parsed = v.safeParse(PosterIdSchema, value);
    return parsed.success ? { kind: 'shown', value: parsed.output } : { kind: 'rejected' };
  } catch {
    return { kind: 'rejected' };
  }
}

/**
 * The poster's `slack_message.app_id` and `slack_message.bot_id` (top level only), each shown only
 * when it matches the shape. Pure; never throws, for any input value.
 */
export function readPosterIdentity(slackMessage: Record<string, unknown> | undefined): PosterIdentity {
  return { appId: readPosterId(slackMessage, 'app_id'), botId: readPosterId(slackMessage, 'bot_id') };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Rendered {
  /** The lines written to the section. */
  lines: string[];
  /** The lines that may become the notification summary (no `### ` prefix, no divider). */
  plain: string[];
}

type BlockResult =
  | { kind: 'rendered'; value: Rendered }
  | { kind: 'ignored' }
  | { kind: 'notShown' };

const NOT_SHOWN: BlockResult = { kind: 'notShown' };

function renderBlock(entry: unknown): BlockResult {
  const parsed = v.safeParse(BlockSchema, entry);
  if (!parsed.success) return NOT_SHOWN;
  const block = parsed.output;
  switch (block.type) {
    case 'header': {
      const line = toSingleLine(textOf(block.text) ?? '');
      if (line === '') return NOT_SHOWN;
      return { kind: 'rendered', value: { lines: [`### ${line}`], plain: [line] } };
    }
    case 'section': {
      const lines = cleanTexts([textOf(block.text), ...listOf(block.fields).map(textOf)]);
      if (lines.length === 0) return NOT_SHOWN;
      return { kind: 'rendered', value: { lines, plain: lines } };
    }
    case 'context': {
      const lines = cleanTexts(listOf(block.elements).map(textOf));
      if (lines.length === 0) return NOT_SHOWN;
      return { kind: 'rendered', value: { lines, plain: lines } };
    }
    case 'divider':
      return { kind: 'rendered', value: { lines: ['---'], plain: [] } };
    case 'rich_text':
      return { kind: 'ignored' };
    default:
      return NOT_SHOWN;
  }
}

/** One block, isolated: whatever the entry does (a throwing getter included), it is "not shown". */
function renderBlockSafely(entry: unknown): BlockResult {
  try {
    return renderBlock(entry);
  } catch {
    return NOT_SHOWN;
  }
}

function attachmentFieldLine(entry: unknown): string | null {
  const parsed = v.safeParse(AttachmentFieldSchema, entry);
  if (!parsed.success) return null;
  const title = cleanText(stringOf(parsed.output.title));
  const value = cleanText(stringOf(parsed.output.value));
  if (title !== null && value !== null) return `${title}: ${value}`;
  return title ?? value;
}

/** Null when the attachment yields nothing (it is then counted as one not-shown entry). */
function renderAttachment(entry: unknown): { rendered: Rendered; nestedNotShown: number } | null {
  const parsed = v.safeParse(AttachmentSchema, entry);
  if (!parsed.success) return null;
  const attachment = parsed.output;

  const head = cleanTexts([
    stringOf(attachment.pretext),
    stringOf(attachment.title),
    stringOf(attachment.text),
    ...listOf(attachment.fields).map(attachmentFieldLine),
  ]);
  const nestedLines: string[] = [];
  const nestedPlain: string[] = [];
  let nestedNotShown = 0;
  for (const nested of listOf(attachment.blocks)) {
    const result = renderBlockSafely(nested);
    if (result.kind === 'rendered') {
      nestedLines.push(...result.value.lines);
      nestedPlain.push(...result.value.plain);
    } else if (result.kind === 'notShown') {
      nestedNotShown += 1;
    }
  }

  if (head.length > 0 || nestedPlain.length > 0) {
    return { rendered: { lines: [...head, ...nestedLines], plain: [...head, ...nestedPlain] }, nestedNotShown };
  }
  const fallback = cleanText(stringOf(attachment.fallback));
  if (fallback !== null) return { rendered: { lines: [fallback], plain: [fallback] }, nestedNotShown };
  if (nestedLines.length > 0) return { rendered: { lines: nestedLines, plain: [] }, nestedNotShown };
  return null;
}

function renderAttachmentSafely(entry: unknown): { rendered: Rendered; nestedNotShown: number } | null {
  try {
    return renderAttachment(entry);
  } catch {
    return null;
  }
}

function readList(message: Record<string, unknown> | undefined, key: 'blocks' | 'attachments'): unknown[] {
  if (message === undefined) return [];
  try {
    return listOf(message[key]);
  } catch {
    return [];
  }
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes at a code-point boundary. */
function cutAtByteCap(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, cut: false };
  const bytes = Buffer.from(text, 'utf8');
  let end = maxBytes;
  // Byte `end` is the first byte left out; while it is a continuation byte, the cut is mid code point.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

function firstNonEmptyLine(plain: string[]): string | null {
  for (const text of plain) {
    for (const line of text.split('\n')) {
      if (line.trim() !== '') return line;
    }
  }
  return null;
}

/**
 * Project the readable text of `slackMessage.blocks` / `slackMessage.attachments`. Pure and
 * synchronous; never throws, for any input value.
 */
export function projectSlackContent(
  slackMessage: Record<string, unknown> | undefined,
  senderTruncated: boolean,
): SlackContentProjection {
  const blocks = readList(slackMessage, 'blocks');
  const attachments = readList(slackMessage, 'attachments');

  const chunks: string[][] = [];
  let firstLine: string | null = null;
  let notShown = 0;
  const addChunk = (rendered: Rendered): void => {
    chunks.push(rendered.lines);
    if (firstLine === null) firstLine = firstNonEmptyLine(rendered.plain);
  };

  for (const entry of blocks) {
    const result = renderBlockSafely(entry);
    switch (result.kind) {
      case 'rendered':
        addChunk(result.value);
        break;
      case 'notShown':
        notShown += 1;
        break;
      case 'ignored':
        break;
      default: {
        const _exhaustive: never = result;
        throw new Error(`Unhandled block result: ${String(_exhaustive)}`);
      }
    }
  }
  for (const entry of attachments) {
    const result = renderAttachmentSafely(entry);
    if (result === null) {
      notShown += 1;
    } else {
      notShown += result.nestedNotShown;
      addChunk(result.rendered);
    }
  }

  const counts: SlackContentCounts = {
    blocksSeen: blocks.length,
    attachmentsSeen: attachments.length,
    chunks: chunks.length,
    notShown,
    cut: false,
  };
  if (chunks.length === 0 && notShown === 0 && !senderTruncated) {
    return { section: null, firstLine, counts };
  }

  const joined = chunks.map((chunk) => chunk.join('\n')).join('\n\n');
  const capped = cutAtByteCap(joined, SLACK_CONTENT_MAX_BYTES);
  counts.cut = capped.cut;

  const section = [SECTION_HEADING, '', READING_NOTE];
  if (capped.text !== '') section.push('', ...capped.text.split('\n'));
  if (capped.cut) section.push('', CUT_NOTICE);
  if (notShown > 0) {
    section.push('', `(${notShown} ${notShown === 1 ? 'block' : 'blocks'} without projectable text not shown.)`);
  }
  if (senderTruncated) section.push('', SENDER_TRUNCATED_NOTICE);
  return { section, firstLine, counts };
}
