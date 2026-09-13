/** Maximum number of files that can be attached to a single worker message. */
export const MAX_MESSAGE_FILES = 10;

/** Maximum total file size in bytes for message attachments (10 MB). */
export const MAX_TOTAL_FILE_SIZE = 10 * 1024 * 1024;

/**
 * MIME types the embedded-agent subprocess treats as an image attachment:
 * read bytes, base64, build an engine-specific image content part. Any
 * other attachment mime type stays path-only.
 * Single writer -- both the route's per-image size cap and the subprocess's
 * content-block builder must use this same list.
 */
export const EMBEDDED_AGENT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Per-image cap in bytes, checked BEFORE base64 (base64 inflates by ~4/3). Only applies to files whose mime type is in EMBEDDED_AGENT_IMAGE_MIME_TYPES -- non-image files are governed only by the existing MAX_TOTAL_FILE_SIZE. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
