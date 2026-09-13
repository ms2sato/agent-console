/**
 * Resolution and content-building for message attachments.
 *
 * `resolveImageAttachments` is the ONE fs-touching seam both engines and the
 * restore seed call through: it reads image-mime attachments into base64 (or
 * declares them unavailable), confined to `attachmentRoots`. The two
 * `build*UserContent` functions are pure -- they never touch the filesystem --
 * and turn a resolved array into the engine-specific content shape.
 *
 * `buildUserMessageContent` is the single entry point that composes both
 * halves for the openai-api shape, used identically by the live turn path
 * (`agent-loop.ts`) and the restore-boundary seed (`main.ts`) -- see
 * docs/design/embedded-agent-worker.md and the Architect's ruling for
 * why this must be one function rather than two call sites each doing
 * resolve-then-build.
 */
import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { EMBEDDED_AGENT_IMAGE_MIME_TYPES, type EmbeddedAgentAttachment } from '@agent-console/shared';
import { isPathWithinRoots } from './tools/path-confinement.js';
import type { ContentPart } from './providers/types.js';
import type { TextBlockParam, ImageBlockParam, Base64ImageSource } from '@anthropic-ai/sdk/resources';

type ImageMimeType = Base64ImageSource['media_type'];

type ResolvedImage =
  | { attachment: EmbeddedAgentAttachment; basename: string; base64: string }
  | { attachment: EmbeddedAgentAttachment; basename: string; unavailable: true };

const IMAGE_MIME_TYPES: readonly string[] = EMBEDDED_AGENT_IMAGE_MIME_TYPES;

/**
 * A one-line notice appended when a resolved image cannot be shown to the
 * model -- because the file is gone (restore, or a race with deletion) or
 * because the provider declares it cannot see images at all. Distinct
 * wording per cause: the first names the specific file, the second is a
 * fixed, provider-capability notice.
 */
function missingImageNote(basename: string): string {
  return `[image no longer available: ${basename}]`;
}

const CANNOT_VIEW_IMAGES_NOTE =
  '[Note: this model cannot view images -- the file path above is provided for reference only.]';

/**
 * Resolve every IMAGE-mime attachment (per EMBEDDED_AGENT_IMAGE_MIME_TYPES)
 * in `attachments` to either its base64 bytes (present + confined) or an
 * "unavailable" marker (missing, unreadable, or resolves outside
 * attachmentRoots -- all three collapse to the same declared-divergence
 * outcome; a caller never distinguishes WHY). Non-image attachments are not
 * present in the returned array at all -- they stay path-only per #1570
 * semantics, handled entirely by the already-folded text the caller passes
 * separately.
 *
 * Engine/capability-agnostic: this function always does the fs work,
 * regardless of whether the destination engine can use the result. The
 * capability gate (`supportsImages`) belongs in the `build*UserContent`
 * functions below, so the SAME resolved array can feed either engine.
 */
export async function resolveImageAttachments(
  attachments: EmbeddedAgentAttachment[] | undefined,
  attachmentRoots: string[],
): Promise<ResolvedImage[]> {
  const imageAttachments = (attachments ?? []).filter((a) => IMAGE_MIME_TYPES.includes(a.mimeType));

  return Promise.all(
    imageAttachments.map(async (attachment): Promise<ResolvedImage> => {
      const basename = path.basename(attachment.path);
      const confinement = await isPathWithinRoots(attachment.path, attachmentRoots);
      if (!confinement.ok) {
        return { attachment, basename, unavailable: true };
      }
      try {
        const bytes = await fsPromises.readFile(confinement.resolvedPath);
        return { attachment, basename, base64: bytes.toString('base64') };
      } catch {
        return { attachment, basename, unavailable: true };
      }
    }),
  );
}

/**
 * Append missing-image notes and (when relevant) the cannot-view-images
 * notice to `text`, joined per the convention: the first appended block with
 * `\n\n`, subsequent ones with `\n`.
 */
function appendNotes(text: string, notes: string[]): string {
  if (notes.length === 0) return text;
  return `${text}\n\n${notes.join('\n')}`;
}

/**
 * Build openai-api Chat-Completions user content. `resolved` must come from
 * `resolveImageAttachments` (same attachments, same attachmentRoots) -- this
 * function does no fs access itself. `supportsImages: false` suppresses
 * EVERY image_url part (even present ones) and instead appends a one-line
 * notice that the model cannot see the image. Returns a plain `text` string,
 * unchanged, when `resolved` is empty (no image attachments at all) -- the
 * polarity guarantee: a message with no image attachments is byte-identical
 * to pre-existing behavior.
 */
export function buildOpenAiUserContent(
  text: string,
  resolved: ResolvedImage[],
  supportsImages: boolean,
): string | ContentPart[] {
  if (resolved.length === 0) return text;

  if (!supportsImages) {
    return appendNotes(text, [CANNOT_VIEW_IMAGES_NOTE]);
  }

  const missingNotes = resolved
    .filter((r): r is Extract<ResolvedImage, { unavailable: true }> => 'unavailable' in r)
    .map((r) => missingImageNote(r.basename));
  const parts: ContentPart[] = [{ type: 'text', text: appendNotes(text, missingNotes) }];
  for (const r of resolved) {
    if ('unavailable' in r) continue;
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${r.attachment.mimeType};base64,${r.base64}` },
    });
  }
  return parts;
}

/**
 * Build claude-sdk user content blocks. No `supportsImages` gate -- claude-sdk
 * has no such capability concept. Returns `text`
 * unchanged when `resolved` is empty, mirroring `buildOpenAiUserContent`'s
 * polarity guarantee.
 *
 * `resolved` is produced by `resolveImageAttachments`, which only ever
 * includes attachments whose mimeType passed the
 * `EMBEDDED_AGENT_IMAGE_MIME_TYPES` filter -- identical to
 * `Base64ImageSource['media_type']`'s domain -- so the cast below is safe;
 * there is no runtime else-branch for an "impossible" 5th mime type.
 */
export function buildClaudeSdkUserContent(
  text: string,
  resolved: ResolvedImage[],
): string | Array<TextBlockParam | ImageBlockParam> {
  if (resolved.length === 0) return text;

  const missingNotes = resolved
    .filter((r): r is Extract<ResolvedImage, { unavailable: true }> => 'unavailable' in r)
    .map((r) => missingImageNote(r.basename));
  const blocks: Array<TextBlockParam | ImageBlockParam> = [
    { type: 'text', text: appendNotes(text, missingNotes) },
  ];
  for (const r of resolved) {
    if ('unavailable' in r) continue;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: r.attachment.mimeType as ImageMimeType, data: r.base64 },
    });
  }
  return blocks;
}

/**
 * One-call convenience combining resolve + build for the openai-api shape,
 * used by BOTH agent-loop.ts's live runUserTurn AND main.ts's restored-
 * conversation seeding -- the single seam the Issue's AC and the Architect's
 * ruling both require. Do not inline resolve+build separately at either call
 * site; both must go through this one function.
 */
export async function buildUserMessageContent(
  text: string,
  attachments: EmbeddedAgentAttachment[] | undefined,
  attachmentRoots: string[],
  supportsImages: boolean,
): Promise<string | ContentPart[]> {
  const resolved = await resolveImageAttachments(attachments, attachmentRoots);
  return buildOpenAiUserContent(text, resolved, supportsImages);
}
