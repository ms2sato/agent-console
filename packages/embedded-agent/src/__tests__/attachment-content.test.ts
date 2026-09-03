import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveImageAttachments,
  buildOpenAiUserContent,
  buildClaudeSdkUserContent,
  buildUserMessageContent,
} from '../attachment-content.js';
import type { EmbeddedAgentAttachment } from '@agent-console/shared';

// A minimal valid 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

describe('resolveImageAttachments', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attach-'));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('resolves a present image attachment with matching base64', async () => {
    const filePath = path.join(rootDir, 'screenshot.png');
    await fsPromises.writeFile(filePath, PNG_BYTES);
    const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'image/png' }];

    const resolved = await resolveImageAttachments(attachments, [rootDir]);
    expect(resolved).toHaveLength(1);
    const [entry] = resolved;
    expect('unavailable' in entry).toBe(false);
    if (!('unavailable' in entry)) {
      expect(entry.base64).toBe(PNG_BYTES.toString('base64'));
      expect(entry.basename).toBe('screenshot.png');
    }
  });

  it('marks a missing file as unavailable', async () => {
    const filePath = path.join(rootDir, 'gone.png');
    const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'image/png' }];

    const resolved = await resolveImageAttachments(attachments, [rootDir]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ unavailable: true, basename: 'gone.png' });
  });

  it('never includes a non-image mimeType attachment in the output', async () => {
    const filePath = path.join(rootDir, 'notes.txt');
    await fsPromises.writeFile(filePath, 'hello');
    const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'text/plain' }];

    const resolved = await resolveImageAttachments(attachments, [rootDir]);
    expect(resolved).toHaveLength(0);
  });

  it('marks a path outside attachmentRoots as unavailable', async () => {
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attach-outside-'));
    try {
      const filePath = path.join(outsideDir, 'screenshot.png');
      await fsPromises.writeFile(filePath, PNG_BYTES);
      const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'image/png' }];

      const resolved = await resolveImageAttachments(attachments, [rootDir]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ unavailable: true });
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('buildOpenAiUserContent', () => {
  it('returns a plain string unchanged when there are no resolved images', () => {
    const content = buildOpenAiUserContent('hello', [], true);
    expect(content).toBe('hello');
  });

  it('builds text+image_url parts when a present image and supportsImages is true', () => {
    const resolved = [
      {
        attachment: { path: '/tmp/x.png', mimeType: 'image/png' } as EmbeddedAgentAttachment,
        basename: 'x.png',
        base64: 'abc123',
      },
    ];
    const content = buildOpenAiUserContent('what is this?', resolved, true);
    expect(content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('omits image_url and appends a cannot-view notice when supportsImages is false', () => {
    const resolved = [
      {
        attachment: { path: '/tmp/x.png', mimeType: 'image/png' } as EmbeddedAgentAttachment,
        basename: 'x.png',
        base64: 'abc123',
      },
    ];
    const content = buildOpenAiUserContent('what is this?', resolved, false);
    expect(Array.isArray(content)).toBe(false);
    expect(content).toContain('what is this?');
    expect(content).toContain('cannot view images');
    expect(content).not.toContain('image_url');
  });

  it('appends a missing-image note and builds no image_url for an unavailable image', () => {
    const resolved = [
      {
        attachment: { path: '/tmp/gone.png', mimeType: 'image/png' } as EmbeddedAgentAttachment,
        basename: 'gone.png',
        unavailable: true as const,
      },
    ];
    const content = buildOpenAiUserContent('what is this?', resolved, true);
    expect(content).toEqual([
      { type: 'text', text: 'what is this?\n\n[image no longer available: gone.png]' },
    ]);
  });
});

describe('buildClaudeSdkUserContent', () => {
  it('returns a plain string unchanged when there are no resolved images', () => {
    const content = buildClaudeSdkUserContent('hello', []);
    expect(content).toBe('hello');
  });

  it('builds text+image blocks (Anthropic shapes) for a present image', () => {
    const resolved = [
      {
        attachment: { path: '/tmp/x.png', mimeType: 'image/png' } as EmbeddedAgentAttachment,
        basename: 'x.png',
        base64: 'abc123',
      },
    ];
    const content = buildClaudeSdkUserContent('what is this?', resolved);
    expect(content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('has no supportsImages branch: always emits image blocks for present images', () => {
    const resolved = [
      {
        attachment: { path: '/tmp/x.png', mimeType: 'image/jpeg' } as EmbeddedAgentAttachment,
        basename: 'x.jpg',
        base64: 'def456',
      },
    ];
    const content = buildClaudeSdkUserContent('desc', resolved);
    expect(content).toEqual([
      { type: 'text', text: 'desc' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'def456' } },
    ]);
  });

  it('folds an unavailable image into the text part as a missing-note', () => {
    const resolved = [
      {
        attachment: { path: '/tmp/gone.png', mimeType: 'image/png' } as EmbeddedAgentAttachment,
        basename: 'gone.png',
        unavailable: true as const,
      },
    ];
    const content = buildClaudeSdkUserContent('desc', resolved);
    expect(content).toEqual([{ type: 'text', text: 'desc\n\n[image no longer available: gone.png]' }]);
  });
});

describe('buildUserMessageContent (resolve + build, one seam)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'embedded-agent-attach-combo-'));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  it('resolves a real file and builds openai content in one call', async () => {
    const filePath = path.join(rootDir, 'shot.png');
    await fsPromises.writeFile(filePath, PNG_BYTES);
    const attachments: EmbeddedAgentAttachment[] = [{ path: filePath, mimeType: 'image/png' }];

    const content = await buildUserMessageContent('what word is this?', attachments, [rootDir], true);
    expect(content).toEqual([
      { type: 'text', text: 'what word is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } },
    ]);
  });

  it('returns plain text when there are no attachments', async () => {
    const content = await buildUserMessageContent('hello', undefined, [rootDir], true);
    expect(content).toBe('hello');
  });
});
