import { describe, it, expect, afterEach } from 'bun:test';
import { waitForAbsent } from '../waitForAbsent';

/**
 * Polarity for this helper is NOT re-measured here -- Issue #1899's own body
 * carries the full before/after measurement ledger (bun 1.3.14 + happy-dom
 * 20.0.11: `expect(el).toBeNull()` inside a failing `waitFor` poll cost
 * ~5.9s / +580MB on a 4-tab fixture, vs ~60ms / ~0MB for a boolean-only
 * check). Re-running the old slow shape here would just re-pay that cost on
 * every CI run for no additional evidence.
 */
describe('waitForAbsent', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves once the queried element is removed', async () => {
    const el = document.createElement('div');
    el.id = 'present-then-removed';
    document.body.appendChild(el);

    setTimeout(() => {
      document.getElementById('present-then-removed')?.remove();
    }, 10);

    await expect(
      waitForAbsent(() => document.getElementById('present-then-removed'), { timeout: 500 }),
    ).resolves.toBeUndefined();
  });

  it('rejects with "element still present" when the element is never removed', async () => {
    const el = document.createElement('div');
    el.id = 'never-removed';
    document.body.appendChild(el);

    await expect(
      waitForAbsent(() => document.getElementById('never-removed'), { timeout: 100 }),
    ).rejects.toThrow('element still present');
  });
});
