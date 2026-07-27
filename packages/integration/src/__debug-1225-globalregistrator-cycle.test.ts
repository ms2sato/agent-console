/**
 * TEMPORARY diagnostic for Issue #1225. Removed before PR finalization.
 * Isolates candidate 2 (GlobalRegistrator unregister/register cycle)
 * from candidate 1 (real subprocess spawn) without any real subprocess.
 */
import { describe, it, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

describe('Issue #1225 -- GlobalRegistrator unregister/register cycle only', () => {
  beforeAll(async () => {
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  });

  afterAll(() => {
    if (!GlobalRegistrator.isRegistered) {
      GlobalRegistrator.register();
    }
  });

  it('does nothing else', () => {
    // No real subprocess. Just the register/unregister/re-register cycle.
  });
});
