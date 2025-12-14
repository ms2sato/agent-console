/**
 * ActivityDetector - Agent activity state machine
 *
 * Monitors terminal output to detect agent states (unknown/active/idle/asking)
 * using output rate monitoring and pattern matching.
 *
 * @see docs/activity-detector.md for state diagram and design details
 */

import type { AgentActivityState, AgentActivityPatterns } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('activity-detector');

// ANSI escape sequence removal regex
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;


export interface ActivityDetectorOptions {
  bufferSize?: number;        // Max buffer size (default: 1000)
  debounceMs?: number;        // Debounce time (default: 300ms)
  onStateChange?: (state: AgentActivityState) => void;
  activityPatterns?: AgentActivityPatterns; // Optional patterns from agent definition
  // Configurable timeouts for testing
  rateWindowMs?: number;      // Time window for rate calculation (default: 2000ms)
  activeCountThreshold?: number; // Threshold outputs to consider "active" (default: 20)
  noOutputIdleMs?: number;    // Time with no output to transition to idle (default: 2000ms)
  userTypingTimeoutMs?: number; // User typing timeout (default: 5000ms)
}

export class ActivityDetector {
  private buffer: string = '';
  private bufferSize: number;
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: AgentActivityState = 'idle';
  private onStateChange?: (state: AgentActivityState) => void;
  private lastOutputTime: number = 0;

  // User typing detection
  private userTyping: boolean = false;
  private userTypingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly userTypingTimeoutMs: number;

  // Rate-based detection: track output over sliding time windows
  private outputHistory: { time: number }[] = [];
  // Time window for rate calculation (ms)
  private readonly rateWindowMs: number;
  // Threshold: number of outputs in window to consider "active"
  private readonly activeCountThreshold: number;
  // How long with no output to transition to idle (ms)
  private readonly noOutputIdleMs: number;

  // Flag to suppress rate-based detection after entering asking state
  // (TUI redraws should not trigger active while waiting for user input)
  private suppressRateDetection: boolean = false;

  // Pattern-based detection: compiled regex patterns from agent definition
  private askingPatterns: RegExp[] = [];

  constructor(options: ActivityDetectorOptions = {}) {
    this.bufferSize = options.bufferSize ?? 1000;
    this.debounceMs = options.debounceMs ?? 300;
    this.onStateChange = options.onStateChange;
    this.rateWindowMs = options.rateWindowMs ?? 2000;
    this.activeCountThreshold = options.activeCountThreshold ?? 20;
    this.noOutputIdleMs = options.noOutputIdleMs ?? 2000;
    this.userTypingTimeoutMs = options.userTypingTimeoutMs ?? 5000;

    // Compile asking patterns if provided
    if (options.activityPatterns?.askingPatterns) {
      this.askingPatterns = options.activityPatterns.askingPatterns.map(
        pattern => new RegExp(pattern, 'i')
      );
    }
  }

  /**
   * Process incoming terminal output
   */
  processOutput(data: string): void {
    const now = Date.now();
    this.lastOutputTime = now;

    // Strip ANSI escape sequences for clean character count
    const cleanData = data.replace(ANSI_REGEX, '');

    // Debug: Log all incoming output
    if (cleanData.length > 0) {
      logger.trace({ charCount: cleanData.length, data: cleanData }, 'Received output');
    }

    // Add to buffer for pattern analysis
    this.buffer += data;
    if (this.buffer.length > this.bufferSize) {
      this.buffer = this.buffer.slice(-this.bufferSize);
    }

    // Count-based detection: track output count over time
    this.outputHistory.push({ time: now });

    // Clean old entries from history
    this.outputHistory = this.outputHistory.filter(
      entry => now - entry.time < this.rateWindowMs
    );

    // Count outputs in window
    const outputCount = this.outputHistory.length;

    logger.trace({ outputCount, rateWindowMs: this.rateWindowMs }, 'Output count in window');

    // Count-based state transitions (skip if user is typing or rate detection is suppressed)
    if (outputCount >= this.activeCountThreshold && !this.userTyping && !this.suppressRateDetection) {
      // High output count → active (but not from asking state when suppressed)
      if (this.currentState !== 'active') {
        this.setState('active');
      }
    }

    // Debounce: analyze buffer for patterns after output stops
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.analyzeBuffer();
    }, this.debounceMs);

    // Schedule idle check when in active state
    this.scheduleIdleCheck();
  }


  /**
   * Schedule a check for idle transition (5 seconds after last output)
   */
  private scheduleIdleCheck(): void {
    // Clear existing timer
    if (this.idleCheckTimer) {
      clearTimeout(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    // Only schedule if currently active
    if (this.currentState === 'active') {
      this.idleCheckTimer = setTimeout(() => {
        this.idleCheckTimer = null;
        const timeSinceLastOutput = Date.now() - this.lastOutputTime;
        logger.trace({ timeSinceLastOutput }, 'Idle check');

        if (timeSinceLastOutput >= this.noOutputIdleMs && this.currentState === 'active') {
          this.setState('idle');
        }
      }, this.noOutputIdleMs + 100); // Check slightly after the threshold
    }
  }

  /**
   * Check if any asking pattern matches the buffer
   * Returns false if no patterns are configured (rate-based detection only)
   */
  private hasAskingPattern(text: string): boolean {
    // Skip pattern-based detection if no patterns configured
    if (this.askingPatterns.length === 0) {
      return false;
    }

    for (const pattern of this.askingPatterns) {
      if (pattern.test(text)) {
        return true;
      }
    }
    return false;
  }


  /**
   * Analyze the buffer to detect state (called after output stops)
   * Rate-based detection handles active state; this handles asking patterns
   */
  private analyzeBuffer(): void {
    // Strip ANSI codes for pattern matching
    const cleanBuffer = this.buffer.replace(ANSI_REGEX, '');

    // Get last few lines for analysis
    const lastPart = cleanBuffer.slice(-500);

    // Check for asking patterns (permission prompts)
    if (this.hasAskingPattern(lastPart)) {
      this.setState('asking');
      return;
    }

    // If currently in asking state but no asking pattern found,
    // transition to idle (e.g., after ESC dismissed the prompt)
    if (this.currentState === 'asking') {
      logger.debug('No asking pattern found, transitioning from asking to idle');
      this.setState('idle');
      return;
    }

    // Idle detection is handled by scheduleIdleCheck() (5 seconds no output)
  }

  /**
   * Set state and notify if changed
   */
  private setState(newState: AgentActivityState): void {
    if (this.currentState !== newState) {
      logger.debug({ prevState: this.currentState, newState }, 'State change');
      this.currentState = newState;

      // When entering asking state, suppress rate-based detection
      // (TUI redraws during asking should not trigger active)
      if (newState === 'asking') {
        this.outputHistory = [];
        this.suppressRateDetection = true;
        logger.debug('Rate detection suppressed (entering asking state)');
      }

      this.onStateChange?.(newState);
    }
  }

  /**
   * Get current detected state
   */
  getState(): AgentActivityState {
    return this.currentState;
  }

  /**
   * Called when user input is received (not Enter)
   * Sets userTyping flag and resets timeout
   */
  setUserTyping(): void {
    const wasTyping = this.userTyping;
    this.userTyping = true;

    // Clear output history when typing starts (not on every keystroke)
    if (!wasTyping) {
      this.outputHistory = [];
      logger.trace('User typing: ON (history cleared)');
    } else {
      logger.trace('User typing: ON');
    }

    // Clear existing timer
    if (this.userTypingTimer) {
      clearTimeout(this.userTypingTimer);
    }

    // Set timeout to clear typing flag
    this.userTypingTimer = setTimeout(() => {
      this.userTyping = false;
      this.userTypingTimer = null;
      logger.trace('User typing: OFF (timeout)');
      // When user stops typing, check output rate and transition accordingly
      if (this.currentState !== 'asking') {
        const outputCount = this.outputHistory.length;
        if (outputCount >= this.activeCountThreshold) {
          this.setState('active');
        } else {
          this.setState('idle');
        }
      }
    }, this.userTypingTimeoutMs);
  }

  /**
   * Called when user presses Enter (submit) or ESC (cancel)
   * Clears userTyping flag immediately and checks for state transition
   * @param fromEsc - true if triggered by ESC key (cancel), false for Enter (submit)
   */
  clearUserTyping(fromEsc: boolean = false): void {
    this.userTyping = false;
    logger.trace({ action: fromEsc ? 'cancel' : 'submit' }, 'User typing: OFF');

    // Clear existing timer
    if (this.userTypingTimer) {
      clearTimeout(this.userTypingTimer);
      this.userTypingTimer = null;
    }

    // When ESC is pressed while in 'asking' state:
    // - Clear buffer so old asking patterns don't persist
    // - Re-enable rate detection
    // - Transition to idle (Claude will trigger active if it starts working)
    if (fromEsc && this.currentState === 'asking') {
      logger.debug('Clearing buffer and re-enabling rate detection (ESC in asking state)');
      this.buffer = '';
      this.suppressRateDetection = false;
      // Don't return early - let it transition to idle below
    }

    // When Enter is pressed while in 'asking' state, clear the buffer
    // so old asking patterns don't trigger detection after user responds
    // Also re-enable rate detection since user has responded
    if (!fromEsc && this.currentState === 'asking') {
      logger.debug('Clearing buffer and re-enabling rate detection (Enter in asking state)');
      this.buffer = '';
      this.suppressRateDetection = false;
    }

    // For Enter (submit), transition to idle first, let processOutput() handle active transition
    if (this.currentState !== 'idle') {
      this.setState('idle');
    }
  }

  /**
   * Get time since last output (for external monitoring)
   */
  getTimeSinceLastOutput(): number {
    return Date.now() - this.lastOutputTime;
  }

  /**
   * Reset the detector
   */
  reset(): void {
    this.buffer = '';
    this.currentState = 'idle';
    this.lastOutputTime = 0;
    this.outputHistory = [];
    this.userTyping = false;
    this.suppressRateDetection = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.idleCheckTimer) {
      clearTimeout(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    if (this.userTypingTimer) {
      clearTimeout(this.userTypingTimer);
      this.userTypingTimer = null;
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.idleCheckTimer) {
      clearTimeout(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    if (this.userTypingTimer) {
      clearTimeout(this.userTypingTimer);
      this.userTypingTimer = null;
    }
  }
}
