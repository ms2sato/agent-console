/**
 * Sibling test for `lib/artifact-bookmark-triggers.ts`.
 *
 * Reach measurement (workflow.md "A check's existence is not its detection
 * power"): each function's single `broadcast(...)` call was commented out
 * in turn, this file was run alone, and the failure was observed, then the
 * line was restored. Observed failures:
 *
 * - `emitBookmarkCreated`: "broadcasts the bookmark-created wire shape"
 *   fails (0 calls seen, expected 1; `toHaveBeenCalledWith` never matched).
 * - `emitArtifactCreated`: "broadcasts the artifact-created wire shape"
 *   fails the same way (0 calls seen, expected 1).
 * - `emitBookmarkDeleted`: both the "sourceSessionId present" test (asserts
 *   the record's session, not the differing fallback) and the "null +
 *   fallback provided" test fail (0 calls seen, expected 1); the "null, no
 *   fallback" test still passes (it asserts zero calls), confirming that
 *   test's own polarity is null-branch-specific, not "the function does
 *   nothing at all".
 * - `emitArtifactDeleted`: identical shape to `emitBookmarkDeleted` above --
 *   the two present/fallback tests fail, the no-fallback test still passes.
 */
import { describe, it, expect, mock } from 'bun:test';
import type { AppServerMessage } from '@agent-console/shared';
import {
  emitArtifactCreated,
  emitArtifactDeleted,
  emitBookmarkCreated,
  emitBookmarkDeleted,
} from '../artifact-bookmark-triggers.js';

describe('artifact-bookmark-triggers', () => {
  describe('emitBookmarkCreated', () => {
    it('broadcasts the bookmark-created wire shape', () => {
      const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});
      emitBookmarkCreated(mockBroadcastToApp, { sessionId: 'session-1', bookmarkId: 'bookmark-1' });

      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({
        type: 'bookmark-created',
        sessionId: 'session-1',
        bookmarkId: 'bookmark-1',
      });
    });
  });

  describe('emitArtifactCreated', () => {
    it('broadcasts the artifact-created wire shape', () => {
      const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});
      emitArtifactCreated(mockBroadcastToApp, { sessionId: 'session-1', artifactId: 'artifact-1' });

      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({
        type: 'artifact-created',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
      });
    });
  });

  describe('emitBookmarkDeleted', () => {
    it(
      'when sourceSessionId is present, broadcasts using the RECORD\'s sourceSessionId, ' +
        'ignoring a differing fallback (record wins over fallback)',
      () => {
        const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});
        emitBookmarkDeleted(
          mockBroadcastToApp,
          { sourceSessionId: 'owning-session' },
          'bookmark-1',
          'some-other-fallback-session',
        );

        expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
        expect(mockBroadcastToApp).toHaveBeenCalledWith({
          type: 'bookmark-deleted',
          sessionId: 'owning-session',
          bookmarkId: 'bookmark-1',
        });
      },
    );

    it('when sourceSessionId is null and a fallback is provided, broadcasts using the fallback', () => {
      const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});
      emitBookmarkDeleted(mockBroadcastToApp, { sourceSessionId: null }, 'bookmark-1', 'fallback-session');

      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({
        type: 'bookmark-deleted',
        sessionId: 'fallback-session',
        bookmarkId: 'bookmark-1',
      });
    });

    it('when sourceSessionId is null and no fallback is provided, skips the broadcast without throwing', () => {
      const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});

      expect(() => {
        emitBookmarkDeleted(mockBroadcastToApp, { sourceSessionId: null }, 'bookmark-1');
      }).not.toThrow();

      expect(mockBroadcastToApp).not.toHaveBeenCalled();
    });
  });

  describe('emitArtifactDeleted', () => {
    it(
      'when sourceSessionId is present, broadcasts using the RECORD\'s sourceSessionId, ' +
        'ignoring a differing fallback (record wins over fallback)',
      () => {
        const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});
        emitArtifactDeleted(
          mockBroadcastToApp,
          { sourceSessionId: 'owning-session' },
          'artifact-1',
          'some-other-fallback-session',
        );

        expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
        expect(mockBroadcastToApp).toHaveBeenCalledWith({
          type: 'artifact-deleted',
          sessionId: 'owning-session',
          artifactId: 'artifact-1',
        });
      },
    );

    it('when sourceSessionId is null and a fallback is provided, broadcasts using the fallback', () => {
      const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});
      emitArtifactDeleted(mockBroadcastToApp, { sourceSessionId: null }, 'artifact-1', 'fallback-session');

      expect(mockBroadcastToApp).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToApp).toHaveBeenCalledWith({
        type: 'artifact-deleted',
        sessionId: 'fallback-session',
        artifactId: 'artifact-1',
      });
    });

    it('when sourceSessionId is null and no fallback is provided, skips the broadcast without throwing', () => {
      const mockBroadcastToApp = mock((_msg: AppServerMessage) => {});

      expect(() => {
        emitArtifactDeleted(mockBroadcastToApp, { sourceSessionId: null }, 'artifact-1');
      }).not.toThrow();

      expect(mockBroadcastToApp).not.toHaveBeenCalled();
    });
  });
});
