import { describe, expect, test } from 'bun:test';
import { extractAcceptanceCriteria } from '../delegation-prompt.js';

describe('extractAcceptanceCriteria', () => {
  test('extracts checkbox items from issue body', () => {
    const body = `## Acceptance Criteria
- [ ] Server returns 200 on valid input → unit test
- [ ] Invalid input returns 400 → unit test
- [ ] WebSocket broadcast fires → integration test`;
    const criteria = extractAcceptanceCriteria(body);
    expect(criteria).toEqual([
      'Server returns 200 on valid input → unit test',
      'Invalid input returns 400 → unit test',
      'WebSocket broadcast fires → integration test',
    ]);
  });

  test('returns empty array when no criteria found', () => {
    const body = `## Summary
Some description without acceptance criteria.`;
    expect(extractAcceptanceCriteria(body)).toEqual([]);
  });

  test('returns empty array for null/undefined body', () => {
    expect(extractAcceptanceCriteria(null)).toEqual([]);
    expect(extractAcceptanceCriteria(undefined)).toEqual([]);
  });

  test('ignores checked checkboxes', () => {
    const body = `- [x] Already done
- [ ] Still pending`;
    const criteria = extractAcceptanceCriteria(body);
    expect(criteria).toEqual(['Still pending']);
  });
});
