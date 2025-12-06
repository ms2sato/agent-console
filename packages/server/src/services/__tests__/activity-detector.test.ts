import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityDetector } from '../activity-detector.js';
import type { ClaudeActivityState, AgentActivityPatterns } from '@agents-web-console/shared';

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

describe('ActivityDetector', () => {
  let detector: ActivityDetector;
  let stateChanges: ClaudeActivityState[];

  beforeEach(() => {
    vi.useFakeTimers();
    stateChanges = [];
    detector = new ActivityDetector({
      onStateChange: (state) => stateChanges.push(state),
      activityPatterns: CLAUDE_CODE_PATTERNS,
    });
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start with idle state', () => {
      expect(detector.getState()).toBe('idle');
    });
  });

  describe('state transitions', () => {
    it('should transition to active when output count exceeds threshold', () => {
      // Generate 20+ outputs quickly (threshold is 20 in 2000ms window)
      for (let i = 0; i < 25; i++) {
        detector.processOutput('some output');
      }

      expect(detector.getState()).toBe('active');
      expect(stateChanges).toContain('active');
    });

    it('should transition from active to idle after no output', () => {
      // First become active
      for (let i = 0; i < 25; i++) {
        detector.processOutput('output');
      }
      expect(detector.getState()).toBe('active');

      // Wait for idle timeout (2000ms + 100ms buffer)
      vi.advanceTimersByTime(2200);

      expect(detector.getState()).toBe('idle');
      expect(stateChanges).toContain('idle');
    });

    it('should detect asking state from permission prompt pattern', () => {
      // Simulate permission prompt output
      detector.processOutput('Do you want to create this file?');

      // Wait for debounce (300ms)
      vi.advanceTimersByTime(400);

      expect(detector.getState()).toBe('asking');
    });

    it('should detect asking state from Enter/Tab/Esc menu pattern', () => {
      detector.processOutput('Enter to select, Tab to navigate, Esc to cancel');

      vi.advanceTimersByTime(400);

      expect(detector.getState()).toBe('asking');
    });

    it('should detect asking state from Yes/No selection pattern', () => {
      detector.processOutput('[y] Yes  [n] No');

      vi.advanceTimersByTime(400);

      expect(detector.getState()).toBe('asking');
    });

    it('should keep asking state until user responds (suppressRateDetection)', () => {
      // First enter asking state
      detector.processOutput('Do you want to proceed?');
      vi.advanceTimersByTime(400);
      expect(detector.getState()).toBe('asking');

      // Generate high output - should NOT transition to active due to suppressRateDetection
      for (let i = 0; i < 25; i++) {
        detector.processOutput('working...');
      }

      // Should stay in asking state until user explicitly responds
      expect(detector.getState()).toBe('asking');
    });

    it('should transition from asking to idle when user responds', () => {
      // First enter asking state
      detector.processOutput('Do you want to proceed?');
      vi.advanceTimersByTime(400);
      expect(detector.getState()).toBe('asking');

      // User responds (e.g., pressing Enter)
      detector.clearUserTyping(false);

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

    it('should timeout user typing after 5 seconds', () => {
      detector.setUserTyping();

      // Advance time past typing timeout
      vi.advanceTimersByTime(5100);

      // Generate high output now
      for (let i = 0; i < 25; i++) {
        detector.processOutput('output');
      }

      // Should become active since typing timed out
      expect(detector.getState()).toBe('active');
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
      detector.processOutput('test');

      vi.advanceTimersByTime(1000);

      expect(detector.getTimeSinceLastOutput()).toBeGreaterThanOrEqual(1000);
    });
  });
});
