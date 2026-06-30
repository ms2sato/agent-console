/**
 * Tests for UsernameLookupService — the sync username cache backing
 * `Session.createdByUsername` (Issue #914).
 *
 * Contract under test:
 *  - getUsername is sync; reads only from the cache (no implicit prime).
 *  - prime resolves through UserRepository and caches the result, including
 *    null for missing users so deleted accounts do not generate repeated
 *    DB lookups.
 *  - primeMany resolves a batch in parallel, skipping already-cached and
 *    falsy entries (undefined / null / empty).
 *  - NULL_USERNAME_LOOKUP always returns null (the SessionManager default).
 */

import { describe, it, expect } from 'bun:test';
import type { AuthUser } from '@agent-console/shared';
import type { UserRepository } from '../../repositories/user-repository.js';
import { NULL_USERNAME_LOOKUP, UsernameLookupService } from '../username-lookup.js';

function makeStubRepo(users: Record<string, AuthUser | null>): {
  repo: UserRepository;
  findByIdCalls: string[];
} {
  const findByIdCalls: string[] = [];
  const repo: UserRepository = {
    async upsertByOsUid() {
      throw new Error('upsertByOsUid not used by UsernameLookupService');
    },
    async findById(id: string) {
      findByIdCalls.push(id);
      return users[id] ?? null;
    },
  };
  return { repo, findByIdCalls };
}

describe('UsernameLookupService', () => {
  describe('getUsername (sync)', () => {
    it('returns null when the cache has no entry for the userId', () => {
      const { repo } = makeStubRepo({});
      const lookup = new UsernameLookupService(repo);
      expect(lookup.getUsername('uuid-not-cached')).toBeNull();
    });

    it('returns the username after prime resolves the user', async () => {
      const { repo } = makeStubRepo({
        'uuid-alice': { id: 'uuid-alice', username: 'alice', homeDir: '/home/alice' },
      });
      const lookup = new UsernameLookupService(repo);
      await lookup.prime('uuid-alice');
      expect(lookup.getUsername('uuid-alice')).toBe('alice');
    });
  });

  describe('prime', () => {
    it('caches null when findById returns null (deleted user)', async () => {
      const { repo, findByIdCalls } = makeStubRepo({});
      const lookup = new UsernameLookupService(repo);

      await lookup.prime('deleted-uuid');

      expect(lookup.getUsername('deleted-uuid')).toBeNull();
      expect(findByIdCalls).toEqual(['deleted-uuid']);

      // Subsequent prime is a no-op (cache hit, even for null).
      await lookup.prime('deleted-uuid');
      expect(findByIdCalls).toEqual(['deleted-uuid']);
    });

    it('does not re-fetch when the userId is already cached', async () => {
      const { repo, findByIdCalls } = makeStubRepo({
        'uuid-alice': { id: 'uuid-alice', username: 'alice', homeDir: '/home/alice' },
      });
      const lookup = new UsernameLookupService(repo);

      await lookup.prime('uuid-alice');
      await lookup.prime('uuid-alice');
      await lookup.prime('uuid-alice');

      expect(findByIdCalls).toEqual(['uuid-alice']);
    });
  });

  describe('primeMany', () => {
    it('resolves a batch of unique userIds in parallel', async () => {
      const { repo, findByIdCalls } = makeStubRepo({
        'uuid-a': { id: 'uuid-a', username: 'alice', homeDir: '/home/a' },
        'uuid-b': { id: 'uuid-b', username: 'bob', homeDir: '/home/b' },
      });
      const lookup = new UsernameLookupService(repo);

      await lookup.primeMany(['uuid-a', 'uuid-b']);

      expect(lookup.getUsername('uuid-a')).toBe('alice');
      expect(lookup.getUsername('uuid-b')).toBe('bob');
      expect(findByIdCalls.sort()).toEqual(['uuid-a', 'uuid-b']);
    });

    it('skips falsy entries (undefined / null) without hitting findById', async () => {
      const { repo, findByIdCalls } = makeStubRepo({});
      const lookup = new UsernameLookupService(repo);

      await lookup.primeMany([undefined, null, '']);

      expect(findByIdCalls).toEqual([]);
    });

    it('deduplicates the batch so each userId is fetched at most once', async () => {
      const { repo, findByIdCalls } = makeStubRepo({
        'uuid-a': { id: 'uuid-a', username: 'alice', homeDir: '/home/a' },
      });
      const lookup = new UsernameLookupService(repo);

      await lookup.primeMany(['uuid-a', 'uuid-a', 'uuid-a']);

      expect(findByIdCalls).toEqual(['uuid-a']);
    });

    it('skips userIds that are already cached from a previous prime', async () => {
      const { repo, findByIdCalls } = makeStubRepo({
        'uuid-a': { id: 'uuid-a', username: 'alice', homeDir: '/home/a' },
        'uuid-b': { id: 'uuid-b', username: 'bob', homeDir: '/home/b' },
      });
      const lookup = new UsernameLookupService(repo);

      await lookup.prime('uuid-a');
      findByIdCalls.length = 0;

      await lookup.primeMany(['uuid-a', 'uuid-b']);

      expect(findByIdCalls).toEqual(['uuid-b']);
    });
  });
});

describe('NULL_USERNAME_LOOKUP', () => {
  it('always returns null', () => {
    expect(NULL_USERNAME_LOOKUP.getUsername('any-uuid')).toBeNull();
    expect(NULL_USERNAME_LOOKUP.getUsername('')).toBeNull();
  });
});
