/**
 * Attachment fetch of the generic signed inbound webhook (receive half).
 *
 * The sender's `slack_files[].url` is a short-lived download-token URL on one fixed host. It is
 * read here once, fetched once into memory and discarded: the URL and its token appear in no
 * returned value, no thrown error and no log line. Everything is best effort. A file that is
 * refused, slow, too large or failing is skipped and counted, never retried, and never stops the
 * message body from being delivered. This module imports nothing from the action half.
 */
import { createLogger } from '../../lib/logger.js';
import { outboundFetch } from '../../lib/outbound-tls.js';
import { serverConfig } from '../../lib/server-config.js';

const logger = createLogger('inbound-webhook-attachments');

/**
 * The only host attachments are fetched from. A hardcoded constant on purpose: not configurable,
 * not in server-config, so no setting can widen where the server will connect to.
 */
const ATTACHMENT_HOST = 'firebasestorage.googleapis.com';

/** Name used when nothing usable is left of the sender's file name. */
const FALLBACK_FILE_NAME = 'attachment';

const MAX_NAME_CODE_POINTS = 100;
/** Below the path resolver's 250-byte bound, so a 4-byte-per-character name still fits. */
const MAX_NAME_BYTES = 240;
/** A trailing `.xxx` longer than this (dot included, in code points) is not treated as an extension. */
const MAX_EXTENSION_CODE_POINTS = 20;

/** The `slack_files` entry as the body schema parses it. */
export interface AttachmentFileEntry {
  name?: string;
  mimetype?: string;
  size?: number;
  url?: string;
}

export interface AttachmentFetchLimits {
  /** Per file, for the whole transfer. */
  timeoutMs: number;
  /** Per file. */
  maxBytes: number;
  /** Files attempted per message; the rest are skipped. */
  maxCount: number;
}

/** What `fetch` is used for here; the global `fetch` satisfies it. */
export type AttachmentFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal },
) => Promise<Response>;

export interface AttachmentFetchDeps {
  /** Defaults to `outboundFetch`, so the OS CA bundle governs the connection. */
  fetch?: AttachmentFetch;
  limits?: AttachmentFetchLimits;
}

export interface FetchedAttachment {
  /** Sanitized, unique within the message; safe to use as one path segment. */
  name: string;
  bytes: Uint8Array;
}

export interface FetchAttachmentsResult {
  fetched: FetchedAttachment[];
  /** Files not fetched for any reason: refused URL, size, timeout, failure, over the count cap. */
  skipped: number;
}

export function defaultAttachmentLimits(): AttachmentFetchLimits {
  return {
    timeoutMs: serverConfig.INBOUND_WEBHOOK_ATTACHMENT_TIMEOUT_MS,
    maxBytes: serverConfig.INBOUND_WEBHOOK_ATTACHMENT_MAX_BYTES,
    maxCount: serverConfig.INBOUND_WEBHOOK_ATTACHMENT_MAX_COUNT,
  };
}

// ---------------------------------------------------------------------------
// URL pin
// ---------------------------------------------------------------------------

/**
 * The parsed URL when `rawUrl` may be fetched, otherwise null: https, the pinned host by exact
 * equality on the PARSED hostname, no credentials, no explicit port. The URL parser lowercases the
 * host, so an upper-case spelling of the pinned host is the pinned host; an IDN, an IP literal or a
 * trailing-dot form does not equal it and is refused. The caller connects to the returned
 * `href`, so what was checked is exactly what is fetched.
 */
export function parseAllowedAttachmentUrl(rawUrl: string | undefined): URL | null {
  if (rawUrl === undefined || rawUrl === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const allowed =
    parsed.protocol === 'https:' &&
    parsed.hostname === ATTACHMENT_HOST &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '';
  return allowed ? parsed : null;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** C0 and C1 controls, line/paragraph separators, bidi overrides and isolates, zero-width marks. */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  const ext = name.slice(dot);
  if (Array.from(ext).length > MAX_EXTENSION_CODE_POINTS) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext };
}

/**
 * `stem + suffix + ext` within the code-point and byte caps. Only the stem is shortened (never
 * mid code point), so the suffix and the extension always survive.
 */
function fitName(stem: string, ext: string, suffix = ''): string {
  const codePoints = Array.from(stem);
  const tail = suffix + ext;
  const tailCodePoints = Array.from(tail).length;
  const tailBytes = Buffer.byteLength(tail, 'utf-8');
  let kept = Math.max(1, Math.min(codePoints.length, MAX_NAME_CODE_POINTS - tailCodePoints));
  while (kept > 1 && Buffer.byteLength(codePoints.slice(0, kept).join(''), 'utf-8') + tailBytes > MAX_NAME_BYTES) {
    kept -= 1;
  }
  return codePoints.slice(0, kept).join('') + tail;
}

/**
 * Turn the sender's file name into a safe single path segment. The name is data from outside: only
 * its last path component survives (both `/` and `\` separate), controls and invisible
 * direction/space marks are dropped, a name that is empty or only dots becomes `attachment`, and
 * the length is capped in code points (never splitting a surrogate pair) while keeping the
 * extension. The declared mimetype plays no part.
 */
export function sanitizeAttachmentName(raw: string | undefined): string {
  const withoutUnsafe = (raw ?? '').replace(UNSAFE_NAME_CHARS, '');
  const segments = withoutUnsafe.split(/[/\\]/).filter((segment) => segment.trim() !== '');
  const base = (segments[segments.length - 1] ?? '').trim();
  if (base === '' || /^\.+$/.test(base)) return FALLBACK_FILE_NAME;
  const { stem, ext } = splitExtension(base);
  return fitName(stem, ext);
}

/**
 * Make `names` unique, in order: the second occurrence of `a.png` becomes `a-2.png`, the third
 * `a-3.png`. Comparison ignores case, so the result is also unique on a case-insensitive disk.
 */
export function uniqueAttachmentNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const { stem, ext } = splitExtension(name);
      for (let n = 2; ; n++) {
        candidate = fitName(stem, ext, `-${n}`);
        if (!taken.has(candidate.toLowerCase())) break;
      }
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

type SkipReason =
  | 'url-refused'
  | 'declared-too-large'
  | 'redirect'
  | 'http-status'
  | 'content-length-too-large'
  | 'stream-too-large'
  | 'timeout'
  | 'fetch-failed';

/** Thrown inside one file's transfer to end it with a reason. Its text never carries a URL. */
class AttachmentSkip extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

interface TransferState {
  reader: { cancel(): Promise<void> } | null;
}

async function readCapped(response: Response, maxBytes: number, state: TransferState): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AttachmentSkip('content-length-too-large');
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  state.reader = reader;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AttachmentSkip('stream-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function download(
  url: string,
  fetchImpl: AttachmentFetch,
  limits: AttachmentFetchLimits,
  signal: AbortSignal,
  state: TransferState,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'manual', signal });
  } catch {
    throw new AttachmentSkip(signal.aborted ? 'timeout' : 'fetch-failed');
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    throw new AttachmentSkip('redirect');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AttachmentSkip('http-status');
  }
  try {
    return await readCapped(response, limits.maxBytes, state);
  } catch (error) {
    if (error instanceof AttachmentSkip) throw error;
    throw new AttachmentSkip(signal.aborted ? 'timeout' : 'fetch-failed');
  }
}

/** One file: the bytes, or a reason. Never throws, never returns or logs the URL. */
async function fetchOne(
  entry: AttachmentFileEntry,
  fetchImpl: AttachmentFetch,
  limits: AttachmentFetchLimits,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: SkipReason }> {
  const url = parseAllowedAttachmentUrl(entry.url);
  if (!url) return { ok: false, reason: 'url-refused' };
  if (typeof entry.size === 'number' && entry.size > limits.maxBytes) return { ok: false, reason: 'declared-too-large' };

  const controller = new AbortController();
  const state: TransferState = { reader: null };
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  // The transfer is raced against the abort so a fetch or stream that ignores the signal is still abandoned.
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new AttachmentSkip('timeout')), { once: true });
  });
  aborted.catch(() => {});
  const transfer = download(url.href, fetchImpl, limits, controller.signal, state);
  transfer.catch(() => {});
  try {
    return { ok: true, bytes: await Promise.race([transfer, aborted]) };
  } catch (error) {
    return { ok: false, reason: error instanceof AttachmentSkip ? error.reason : 'fetch-failed' };
  } finally {
    clearTimeout(timer);
    // Release a stream that was abandoned (timeout) or left open; a no-op when already closed.
    await state.reader?.cancel().catch(() => {});
  }
}

/**
 * Fetch the message's attachments, sequentially, in payload order. At most `limits.maxCount` files
 * are attempted; the rest are counted as skipped. Fetched names are sanitized and unique.
 */
export async function fetchAttachments(
  files: AttachmentFileEntry[],
  deps: AttachmentFetchDeps = {},
): Promise<FetchAttachmentsResult> {
  const fetchImpl: AttachmentFetch = deps.fetch ?? outboundFetch;
  const limits = deps.limits ?? defaultAttachmentLimits();
  const attempted = files.slice(0, limits.maxCount);
  let skipped = files.length - attempted.length;

  const collected: { name: string; bytes: Uint8Array }[] = [];
  for (const [index, entry] of attempted.entries()) {
    const result = await fetchOne(entry, fetchImpl, limits);
    if (result.ok) {
      collected.push({ name: sanitizeAttachmentName(entry.name), bytes: result.bytes });
    } else {
      skipped += 1;
      logger.warn({ index, reason: result.reason }, 'Inbound webhook attachment skipped');
    }
  }

  const names = uniqueAttachmentNames(collected.map((item) => item.name));
  const fetched = collected.map((item, i) => ({ name: names[i] as string, bytes: item.bytes }));
  if (files.length > attempted.length) {
    logger.warn({ attempted: attempted.length, skippedOverCap: files.length - attempted.length }, 'Inbound webhook attachments over the count cap skipped');
  }
  return { fetched, skipped };
}
