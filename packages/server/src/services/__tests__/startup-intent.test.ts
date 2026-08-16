/**
 * Unit tests for resolveStartupIntent (Issue #1299).
 *
 * Covers the full contract matrix (3 preferences x 2 obligation states),
 * plus the individual obligation sub-conditions (eligibility, non-empty
 * prompt, not-yet-delivered) that combine into "obligated".
 */
import { describe, it, expect } from 'bun:test';
import { resolveStartupIntent, type StartupIntentInput } from '../startup-intent.js';

const OBLIGATED: StartupIntentInput = {
  deliverInitialPromptOnActivation: true,
  initialPrompt: 'Do the important thing',
  initialPromptDelivered: false,
};

const NOT_OBLIGATED: StartupIntentInput = {
  deliverInitialPromptOnActivation: false,
  initialPrompt: undefined,
  initialPromptDelivered: undefined,
};

describe('resolveStartupIntent', () => {
  // ========== Full contract matrix: 3 preferences x 2 obligation states ==========

  describe('preference: continue', () => {
    it('resolves to continue when obligated (honored unconditionally)', () => {
      expect(resolveStartupIntent('continue', OBLIGATED)).toBe('continue');
    });

    it('resolves to continue when not obligated', () => {
      expect(resolveStartupIntent('continue', NOT_OBLIGATED)).toBe('continue');
    });
  });

  describe('preference: fresh', () => {
    it('resolves to deliver-initial-prompt when obligated', () => {
      expect(resolveStartupIntent('fresh', OBLIGATED)).toBe('deliver-initial-prompt');
    });

    it('resolves to fresh when not obligated', () => {
      expect(resolveStartupIntent('fresh', NOT_OBLIGATED)).toBe('fresh');
    });
  });

  describe('preference: system', () => {
    it('resolves to deliver-initial-prompt when obligated', () => {
      expect(resolveStartupIntent('system', OBLIGATED)).toBe('deliver-initial-prompt');
    });

    it('resolves to continue when not obligated', () => {
      expect(resolveStartupIntent('system', NOT_OBLIGATED)).toBe('continue');
    });
  });

  // ========== Obligation sub-conditions ==========
  // Each of these individually flips "obligated" to false; only preferences
  // that read obligation ('fresh', 'system') can observe the difference.
  // 'continue' is excluded here since it is provably indifferent to
  // obligation per the matrix above.

  describe('obligation sub-conditions', () => {
    it('is not obligated when deliverInitialPromptOnActivation is false', () => {
      const input: StartupIntentInput = { ...OBLIGATED, deliverInitialPromptOnActivation: false };
      expect(resolveStartupIntent('fresh', input)).toBe('fresh');
      expect(resolveStartupIntent('system', input)).toBe('continue');
    });

    it('is not obligated when initialPrompt is undefined', () => {
      const input: StartupIntentInput = { ...OBLIGATED, initialPrompt: undefined };
      expect(resolveStartupIntent('fresh', input)).toBe('fresh');
      expect(resolveStartupIntent('system', input)).toBe('continue');
    });

    it('is not obligated when initialPrompt is empty', () => {
      const input: StartupIntentInput = { ...OBLIGATED, initialPrompt: '' };
      expect(resolveStartupIntent('fresh', input)).toBe('fresh');
      expect(resolveStartupIntent('system', input)).toBe('continue');
    });

    it('is not obligated when initialPrompt is whitespace-only', () => {
      const input: StartupIntentInput = { ...OBLIGATED, initialPrompt: '   \n\t  ' };
      expect(resolveStartupIntent('fresh', input)).toBe('fresh');
      expect(resolveStartupIntent('system', input)).toBe('continue');
    });

    it('is not obligated when initialPromptDelivered is already true', () => {
      const input: StartupIntentInput = { ...OBLIGATED, initialPromptDelivered: true };
      expect(resolveStartupIntent('fresh', input)).toBe('fresh');
      expect(resolveStartupIntent('system', input)).toBe('continue');
    });

    it('is obligated when initialPromptDelivered is undefined (never set)', () => {
      const input: StartupIntentInput = { ...OBLIGATED, initialPromptDelivered: undefined };
      expect(resolveStartupIntent('fresh', input)).toBe('deliver-initial-prompt');
      expect(resolveStartupIntent('system', input)).toBe('deliver-initial-prompt');
    });
  });
});
