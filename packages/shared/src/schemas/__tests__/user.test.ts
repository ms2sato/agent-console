import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import { DirectoryUserSchema, UsersListResponseSchema } from '../user.js';

describe('UsersListResponseSchema', () => {
  it('accepts a list of id + username entries', () => {
    const result = v.safeParse(UsersListResponseSchema, {
      users: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts the empty list', () => {
    expect(v.safeParse(UsersListResponseSchema, { users: [] }).success).toBe(true);
  });

  it('rejects an entry carrying any column beyond id and username', () => {
    expect(v.safeParse(DirectoryUserSchema, { id: 'u1', username: 'alice', homeDir: '/home/alice' }).success).toBe(false);
    expect(v.safeParse(DirectoryUserSchema, { id: 'u1', username: 'alice', osUid: 1000 }).success).toBe(false);
  });

  it('rejects an empty id and a missing username', () => {
    expect(v.safeParse(DirectoryUserSchema, { id: '', username: 'alice' }).success).toBe(false);
    expect(v.safeParse(DirectoryUserSchema, { id: 'u1' }).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(v.safeParse(UsersListResponseSchema, { users: [], total: 0 }).success).toBe(false);
  });
});
