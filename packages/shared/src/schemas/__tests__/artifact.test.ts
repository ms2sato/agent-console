import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { ArtifactSchema, ArtifactsListResponseSchema } from '../artifact.js';
import type { Artifact } from '../../types/artifact.js';

describe('ArtifactSchema', () => {
  it('accepts a well-formed Artifact object (parse-path, closes the #926 silent-drop gap)', () => {
    // Constructed as the shared `Artifact` TS type, then parsed through the
    // wire schema: proves the two are kept in sync (pre-pr-completeness.md
    // Q10). A field added to one but not the other fails this test.
    const artifact: Artifact = {
      id: 'artifact-1',
      title: 'My Dashboard',
      createdAt: '2026-08-16T00:00:00.000Z',
      sizeBytes: 1234,
    };

    const result = v.safeParse(ArtifactSchema, artifact);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual(artifact);
    }
  });

  it('rejects a missing required field', () => {
    const result = v.safeParse(ArtifactSchema, {
      id: 'artifact-1',
      title: 'My Dashboard',
      createdAt: '2026-08-16T00:00:00.000Z',
      // sizeBytes omitted
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative sizeBytes', () => {
    const result = v.safeParse(ArtifactSchema, {
      id: 'artifact-1',
      title: 'My Dashboard',
      createdAt: '2026-08-16T00:00:00.000Z',
      sizeBytes: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer sizeBytes', () => {
    const result = v.safeParse(ArtifactSchema, {
      id: 'artifact-1',
      title: 'My Dashboard',
      createdAt: '2026-08-16T00:00:00.000Z',
      sizeBytes: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty id string (this repo\'s id-field convention, e.g. schemas/agent.ts / embedded-agent.ts, requires minLength(1))', () => {
    const result = v.safeParse(ArtifactSchema, {
      id: '',
      title: 'My Dashboard',
      createdAt: '2026-08-16T00:00:00.000Z',
      sizeBytes: 1234,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty title string (production always resolves a non-empty title -- resolveArtifactTitle falls back to \'Untitled\' -- so an empty title is never a valid wire value)', () => {
    const result = v.safeParse(ArtifactSchema, {
      id: 'artifact-1',
      title: '',
      createdAt: '2026-08-16T00:00:00.000Z',
      sizeBytes: 1234,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key (strict-parse contract, e.g. an accidentally-leaked content field)', () => {
    const result = v.safeParse(ArtifactSchema, {
      id: 'artifact-1',
      title: 'My Dashboard',
      createdAt: '2026-08-16T00:00:00.000Z',
      sizeBytes: 1234,
      content: '<html></html>',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('content');
    }
  });
});

describe('ArtifactsListResponseSchema', () => {
  it('accepts a well-formed { artifacts: [...] } response', () => {
    const artifacts: Artifact[] = [
      { id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z', sizeBytes: 1234 },
      { id: 'artifact-2', title: 'Report', createdAt: '2026-08-15T00:00:00.000Z', sizeBytes: 42 },
    ];

    const result = v.safeParse(ArtifactsListResponseSchema, { artifacts });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ artifacts });
    }
  });

  it('accepts an empty artifacts array (boundary case)', () => {
    const result = v.safeParse(ArtifactsListResponseSchema, { artifacts: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toEqual({ artifacts: [] });
    }
  });

  it('rejects a response missing the artifacts field', () => {
    const result = v.safeParse(ArtifactsListResponseSchema, {});
    expect(result.success).toBe(false);
  });

  it('rejects a response whose array contains an invalid artifact', () => {
    const result = v.safeParse(ArtifactsListResponseSchema, {
      artifacts: [{ id: 'artifact-1', title: 'My Dashboard', createdAt: '2026-08-16T00:00:00.000Z' /* sizeBytes omitted */ }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict-parse contract)', () => {
    const result = v.safeParse(ArtifactsListResponseSchema, { artifacts: [], total: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.issues)).toContain('total');
    }
  });
});
