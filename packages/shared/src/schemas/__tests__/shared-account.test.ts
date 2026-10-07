import { describe, it, expect } from 'bun:test';
import * as v from 'valibot';
import {
  RegisterSharedAccountRequestSchema,
  SharedAccountSummarySchema,
  ListSharedAccountsResponseSchema,
} from '../shared-account.js';

describe('RegisterSharedAccountRequestSchema', () => {
  it('accepts a trimmed, non-empty username', () => {
    const result = v.safeParse(RegisterSharedAccountRequestSchema, { username: '  shared-bot  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.username).toBe('shared-bot');
    }
  });

  it('rejects an empty username', () => {
    const result = v.safeParse(RegisterSharedAccountRequestSchema, { username: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing username', () => {
    const result = v.safeParse(RegisterSharedAccountRequestSchema, {});
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    const result = v.safeParse(RegisterSharedAccountRequestSchema, { username: 'bot', extra: true });
    expect(result.success).toBe(false);
  });
});

describe('SharedAccountSummarySchema', () => {
  it('accepts a well-formed summary', () => {
    const result = v.safeParse(SharedAccountSummarySchema, {
      username: 'shared-bot',
      registeredAt: '2026-01-01T00:00:00.000Z',
      boundRepositoryCount: 2,
      sessionCount: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing field', () => {
    const result = v.safeParse(SharedAccountSummarySchema, {
      username: 'shared-bot',
      registeredAt: '2026-01-01T00:00:00.000Z',
      boundRepositoryCount: 2,
    });
    expect(result.success).toBe(false);
  });
});

describe('ListSharedAccountsResponseSchema', () => {
  it('accepts an empty accounts array', () => {
    const result = v.safeParse(ListSharedAccountsResponseSchema, { accounts: [] });
    expect(result.success).toBe(true);
  });

  it('accepts a populated accounts array', () => {
    const result = v.safeParse(ListSharedAccountsResponseSchema, {
      accounts: [
        {
          username: 'shared-bot',
          registeredAt: '2026-01-01T00:00:00.000Z',
          boundRepositoryCount: 0,
          sessionCount: 0,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
