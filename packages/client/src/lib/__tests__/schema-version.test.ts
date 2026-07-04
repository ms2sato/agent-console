import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { SCHEMA_VERSION } from '@agent-console/shared';
import {
  checkServerSchemaVersion,
  getMismatch,
  installSchemaVersionFetchInspector,
  _reset,
  _setReloadImpl,
  _simulateReload,
} from '../schema-version';

// A version string guaranteed to differ from the bundle's compiled-in
// SCHEMA_VERSION, so checkServerSchemaVersion always sees a mismatch.
const SERVER_VERSION = `${SCHEMA_VERSION}-different`;
const OTHER_SERVER_VERSION = `${SCHEMA_VERSION}-another`;

describe('schema-version', () => {
  let reloadMock: ReturnType<typeof mock>;

  beforeEach(() => {
    _reset();
    reloadMock = mock(() => {});
    _setReloadImpl(reloadMock);
  });

  afterEach(() => {
    _reset();
  });

  describe('checkServerSchemaVersion', () => {
    it('does not reload and clears the guard when versions match', () => {
      // Seed a stale guard from a hypothetical prior mismatch.
      window.sessionStorage.setItem('agent-console:schema-version-reload-attempted', SERVER_VERSION);

      checkServerSchemaVersion(SCHEMA_VERSION);

      expect(reloadMock).not.toHaveBeenCalled();
      expect(getMismatch()).toBe(false);
      expect(
        window.sessionStorage.getItem('agent-console:schema-version-reload-attempted'),
      ).toBeNull();
    });

    it('writes the guard BEFORE reloading on first mismatch', () => {
      const guardsSeenAtReload: (string | null)[] = [];
      _setReloadImpl(() => {
        guardsSeenAtReload.push(
          window.sessionStorage.getItem('agent-console:schema-version-reload-attempted'),
        );
      });

      checkServerSchemaVersion(SERVER_VERSION);

      // The guard must already be persisted at the moment reload fires, so it
      // survives the navigation.
      expect(guardsSeenAtReload).toEqual([SERVER_VERSION]);
      expect(getMismatch()).toBe(false);
    });

    it('does NOT reload again for the same version after a reload, and enters mismatch state', () => {
      checkServerSchemaVersion(SERVER_VERSION);
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(getMismatch()).toBe(false);

      // Model the page reload the first mismatch triggered.
      _simulateReload();

      checkServerSchemaVersion(SERVER_VERSION);
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(getMismatch()).toBe(true);
    });

    it('reloads again when a different new version appears after the guard was set', () => {
      checkServerSchemaVersion(SERVER_VERSION);
      expect(reloadMock).toHaveBeenCalledTimes(1);

      _simulateReload();

      // A subsequent deploy advertises yet another version.
      checkServerSchemaVersion(OTHER_SERVER_VERSION);
      expect(reloadMock).toHaveBeenCalledTimes(2);
      expect(getMismatch()).toBe(false);
    });

    it('reloads at most once per page load even across many mismatch calls', () => {
      checkServerSchemaVersion(SERVER_VERSION);
      checkServerSchemaVersion(SERVER_VERSION);
      checkServerSchemaVersion(OTHER_SERVER_VERSION);

      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT auto-reload when the guard cannot be persisted, and enters mismatch state', () => {
      // Simulate sessionStorage being unavailable (e.g. privacy mode) by
      // swapping in a stub whose access throws. A stub via defineProperty is
      // used instead of spyOn because happy-dom materializes per-instance
      // Storage methods after first use, which defeats prototype/instance spies.
      const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      const throwingStorage = {
        getItem() {
          throw new Error('storage disabled');
        },
        setItem() {
          throw new Error('storage disabled');
        },
        removeItem() {
          throw new Error('storage disabled');
        },
      };
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => throwingStorage,
      });

      try {
        checkServerSchemaVersion(SERVER_VERSION);

        // Without a durable guard the reload cannot be bounded to a single
        // attempt, so we skip the automatic reload entirely and surface the
        // manual-refresh banner instead of risking an unbounded reload loop.
        expect(reloadMock).not.toHaveBeenCalled();
        expect(getMismatch()).toBe(true);
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(window, 'sessionStorage', originalDescriptor);
        }
      }
    });
  });

  describe('installSchemaVersionFetchInspector', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('checks the version when the response carries the header', async () => {
      globalThis.fetch = mock(async () =>
        new Response(null, { headers: { 'X-Schema-Version': SERVER_VERSION } }),
      ) as unknown as typeof globalThis.fetch;

      installSchemaVersionFetchInspector();
      await globalThis.fetch('/api/config');

      // A mismatching header drives the reload path.
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('ignores responses without the header', async () => {
      globalThis.fetch = mock(async () => new Response(null)) as unknown as typeof globalThis.fetch;

      installSchemaVersionFetchInspector();
      await globalThis.fetch('/api/config');

      expect(reloadMock).not.toHaveBeenCalled();
    });

    it('returns the original response unchanged', async () => {
      const sentinel = new Response('body', {
        headers: { 'X-Schema-Version': SCHEMA_VERSION },
      });
      globalThis.fetch = mock(async () => sentinel) as unknown as typeof globalThis.fetch;

      installSchemaVersionFetchInspector();
      const result = await globalThis.fetch('/api/config');

      expect(result).toBe(sentinel);
    });

    it('propagates a rejection from the underlying fetch', async () => {
      const error = new Error('network down');
      globalThis.fetch = mock(async () => {
        throw error;
      }) as unknown as typeof globalThis.fetch;

      installSchemaVersionFetchInspector();

      await expect(globalThis.fetch('/api/config')).rejects.toThrow('network down');
    });

    it('is idempotent (does not stack wrappers)', async () => {
      const inner = mock(async () => new Response(null));
      globalThis.fetch = inner as unknown as typeof globalThis.fetch;

      installSchemaVersionFetchInspector();
      installSchemaVersionFetchInspector();
      await globalThis.fetch('/api/config');

      expect(inner).toHaveBeenCalledTimes(1);
    });
  });
});
