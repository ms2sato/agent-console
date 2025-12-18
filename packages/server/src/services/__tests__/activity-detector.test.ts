import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ActivityDetector } from '../activity-detector.js';
import type { AgentActivityState, AgentActivityPatterns } from '@agent-console/shared';
import { travel } from '../../test/time-travel.js';

// Claude Code asking patterns (same as in agent-manager.ts)
const CLAUDE_CODE_PATTERNS: AgentActivityPatterns = {
  askingPatterns: [
    'Enter to select.*Tab.*navigate.*Esc to cancel',
    'Do you want to.*\\?',
    '\\[y\\].*\\[n\\]',
    '\\[a\\].*always',
    'Allow.*\\?',
    '\\[A\\].*\\[B\\]',
    '\\[1\\].*\\[2\\]',
    '╰─+╯\\s*>\\s*$',
  ],
};

// Short timeouts for testing
const TEST_TIMEOUTS = {
  rateWindowMs: 50,
  noOutputIdleMs: 50,
  userTypingTimeoutMs: 100,
  debounceMs: 20,
};

describe('ActivityDetector', () => {
  let detector: ActivityDetector;
  let stateChanges: AgentActivityState[];

  beforeEach(() => {
    stateChanges = [];
    detector = new ActivityDetector({
      onStateChange: (state) => stateChanges.push(state),
      activityPatterns: CLAUDE_CODE_PATTERNS,
      ...TEST_TIMEOUTS,
    });
  });

  afterEach(() => {
    detector.dispose();
  });

  describe('initial state', () => {
    it('should start with idle state', () => {
      expect(detector.getState()).toBe('idle');
    });
  });

  describe('state transitions', () => {
    it('should transition to active when output count exceeds threshold', () => {
      // Generate 20+ outputs quickly (threshold is 20 in rateWindowMs)
      for (let i = 0; i < 25; i++) {
        detector.processOutput('some output');
      }

      expect(detector.getState()).toBe('active');
      expect(stateChanges).toContain('active');
    });

    it('should transition from active to idle after no output', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        // First become active
        for (let i = 0; i < 25; i++) {
          detector.processOutput('output');
        }
        expect(detector.getState()).toBe('active');

        // Advance time past idle timeout
        c.tick(TEST_TIMEOUTS.noOutputIdleMs + 150);

        expect(detector.getState()).toBe('idle');
        expect(stateChanges).toContain('idle');
      });
    });

    it('should detect asking state from permission prompt pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        // Simulate permission prompt output
        detector.processOutput('Do you want to create this file?');

        // Advance time past debounce
        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from Enter/Tab/Esc menu pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('Enter to select, Tab to navigate, Esc to cancel');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from Yes/No selection pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('[y] Yes  [n] No');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from Always allow pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('Allow once  [a] Always allow');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from Allow X? pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('Allow reading file.txt?');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from A/B selection pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('[A] Option A  [B] Option B');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from numbered selection pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('[1] First choice  [2] Second choice');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should detect asking state from box bottom with prompt pattern', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('╰─────────────────────────────────╯ > ');

        c.tick(TEST_TIMEOUTS.debounceMs + 50);

        expect(detector.getState()).toBe('asking');
      });
    });

    it('should keep asking state until user responds (suppressRateDetection)', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        // First enter asking state
        detector.processOutput('Do you want to proceed?');
        c.tick(TEST_TIMEOUTS.debounceMs + 50);
        expect(detector.getState()).toBe('asking');

        // Generate high output - should NOT transition to active due to suppressRateDetection
        for (let i = 0; i < 25; i++) {
          detector.processOutput('working...');
        }

        // Should stay in asking state until user explicitly responds
        expect(detector.getState()).toBe('asking');
      });
    });

    it('should transition from asking to idle when user responds', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        // First enter asking state
        detector.processOutput('Do you want to proceed?');
        c.tick(TEST_TIMEOUTS.debounceMs + 50);
        expect(detector.getState()).toBe('asking');

        // User responds (e.g., pressing Enter)
        detector.clearUserTyping(false);

        expect(detector.getState()).toBe('idle');
      });
    });

    it('should transition from asking to idle when user cancels with ESC', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        // First enter asking state
        detector.processOutput('Do you want to proceed?');
        c.tick(TEST_TIMEOUTS.debounceMs + 50);
        expect(detector.getState()).toBe('asking');

        // User cancels (pressing ESC)
        detector.clearUserTyping(true);

        expect(detector.getState()).toBe('idle');
      });
    });

    it('should not change state if not in asking state when clearUserTyping is called with isCancel', () => {
      // Start in idle state
      expect(detector.getState()).toBe('idle');

      // Call clearUserTyping with isCancel=true - should stay idle
      detector.clearUserTyping(true);

      expect(detector.getState()).toBe('idle');
    });
  });

  describe('user typing', () => {
    it('should not transition to active while user is typing', () => {
      detector.setUserTyping();

      // Generate high output
      for (let i = 0; i < 25; i++) {
        detector.processOutput('echo output');
      }

      // Should stay idle because user is typing
      expect(detector.getState()).toBe('idle');
    });

    it('should clear output history when user starts typing', () => {
      // Generate some output first
      for (let i = 0; i < 10; i++) {
        detector.processOutput('output');
      }

      // Start typing - should clear history
      detector.setUserTyping();

      // Now generate more output (but less than threshold)
      for (let i = 0; i < 15; i++) {
        detector.processOutput('more output');
      }

      // Should still be idle because we cleared history
      expect(detector.getState()).toBe('idle');
    });

    it('should transition to idle when user submits (clearUserTyping)', () => {
      // First become active
      for (let i = 0; i < 25; i++) {
        detector.processOutput('output');
      }
      expect(detector.getState()).toBe('active');

      // User submits
      detector.clearUserTyping();

      expect(detector.getState()).toBe('idle');
    });

    it('should timeout user typing after configured timeout', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.setUserTyping();

        // Advance time past typing timeout
        c.tick(TEST_TIMEOUTS.userTypingTimeoutMs + 50);

        // Generate high output now
        for (let i = 0; i < 25; i++) {
          detector.processOutput('output');
        }

        // Should become active since typing timed out
        expect(detector.getState()).toBe('active');
      });
    });
  });

  describe('buffer management', () => {
    it('should truncate buffer when exceeding size limit', () => {
      const detector = new ActivityDetector({ bufferSize: 100 });

      // Add more than buffer size
      detector.processOutput('a'.repeat(150));

      // Internal buffer should be truncated (we can't check directly,
      // but it shouldn't crash)
      expect(detector.getState()).toBe('idle');

      detector.dispose();
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      // Set up some state
      for (let i = 0; i < 25; i++) {
        detector.processOutput('output');
      }
      expect(detector.getState()).toBe('active');

      // Reset
      detector.reset();

      expect(detector.getState()).toBe('idle');
      expect(detector.getTimeSinceLastOutput()).toBeGreaterThan(0);
    });
  });

  describe('getTimeSinceLastOutput', () => {
    it('should return time since last output', () => {
      travel(new Date('2025-01-01T00:00:00Z'), (c) => {
        detector.processOutput('test');
        c.tick(100);
        expect(detector.getTimeSinceLastOutput()).toBe(100);
      });
    });
  });
});
