/**
 * Sibling test for the artifact viewer's single-use token store (Issue
 * #1366, S2). Every assertion targets the store's own contract in
 * isolation -- HTTP-level wiring (the two-tier gate consuming this store,
 * the shell minting from it) is covered by
 * `routes/__tests__/artifacts.test.ts` and
 * `routes/__tests__/artifacts-viewer.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  mintArtifactViewerToken,
  consumeArtifactViewerToken,
  ARTIFACT_VIEWER_TOKEN_TTL_MS,
  _resetArtifactViewerTokensForTest,
} from '../artifact-viewer-tokens.js';

describe('artifact-viewer-tokens', () => {
  beforeEach(() => {
    _resetArtifactViewerTokensForTest();
  });

  describe('mintArtifactViewerToken', () => {
    it('returns a URL-safe (base64url) 128-bit token', () => {
      const token = mintArtifactViewerToken('artifact-a');
      // crypto.randomBytes(16) -> 16 bytes -> 22 base64url chars (no padding).
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it('returns a distinct token on every call, even for the same artifact id', () => {
      const first = mintArtifactViewerToken('artifact-a');
      const second = mintArtifactViewerToken('artifact-a');
      expect(first).not.toBe(second);
    });
  });

  describe('consumeArtifactViewerToken', () => {
    it('consumes a valid, unspent, id-matching token (serve path)', () => {
      const token = mintArtifactViewerToken('artifact-a');
      expect(consumeArtifactViewerToken(token, 'artifact-a')).toBe(true);
    });

    it('is single-use: an immediate second consume of the SAME token returns false', () => {
      const token = mintArtifactViewerToken('artifact-a');
      expect(consumeArtifactViewerToken(token, 'artifact-a')).toBe(true);
      expect(consumeArtifactViewerToken(token, 'artifact-a')).toBe(false);
    });

    it('returns false for a token that was never minted', () => {
      expect(consumeArtifactViewerToken('not-a-real-token', 'artifact-a')).toBe(false);
    });

    it('is id-bound: a token minted for artifact A never validates against artifact B', () => {
      const token = mintArtifactViewerToken('artifact-a');
      expect(consumeArtifactViewerToken(token, 'artifact-b')).toBe(false);
    });

    it('id-bound (continued): after a wrong-id attempt, the token remains valid for the artifact it WAS minted for', () => {
      const token = mintArtifactViewerToken('artifact-a');
      expect(consumeArtifactViewerToken(token, 'artifact-b')).toBe(false);
      expect(consumeArtifactViewerToken(token, 'artifact-a')).toBe(true);
    });

    it('returns false once the TTL has elapsed (fake clock, no sleeping)', () => {
      let fakeNow = 1_000_000;
      const clock = () => fakeNow;
      const token = mintArtifactViewerToken('artifact-a', clock);

      fakeNow += ARTIFACT_VIEWER_TOKEN_TTL_MS; // exactly at the expiry boundary
      expect(consumeArtifactViewerToken(token, 'artifact-a', clock)).toBe(false);
    });

    it('still succeeds one millisecond before the TTL boundary (fake clock)', () => {
      let fakeNow = 1_000_000;
      const clock = () => fakeNow;
      const token = mintArtifactViewerToken('artifact-a', clock);

      fakeNow += ARTIFACT_VIEWER_TOKEN_TTL_MS - 1;
      expect(consumeArtifactViewerToken(token, 'artifact-a', clock)).toBe(true);
    });

    it('an expired token is swept and does not linger to falsely validate a later mint collision window', () => {
      let fakeNow = 1_000_000;
      const clock = () => fakeNow;
      const token = mintArtifactViewerToken('artifact-a', clock);

      fakeNow += ARTIFACT_VIEWER_TOKEN_TTL_MS + 1;
      // The sweep runs as a side effect of this mint call.
      mintArtifactViewerToken('artifact-b', clock);
      expect(consumeArtifactViewerToken(token, 'artifact-a', clock)).toBe(false);
    });
  });
});
