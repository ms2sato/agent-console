import type { ClaudeActivityState } from '@agents-web-console/shared';

// ANSI escape sequence removal regex
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;


// Detection patterns for Claude Code states
const ASKING_PATTERNS = [
  // Selection menu footer (most reliable - appears on all permission prompts)
  /Enter to select.*Tab.*navigate.*Esc to cancel/i,

  // Permission prompts - Claude Code style
  /Do you want to.*\?/i,              // "Do you want to create/edit/run..." prompts
  /\[y\].*\[n\]/i,                    // Yes/No selection
  /\[a\].*always/i,                   // Always allow option
  /Allow.*\?/i,                       // "Allow X?" prompts

  // AskUserQuestion patterns
  /\[A\].*\[B\]/,                     // A/B selection
  /\[1\].*\[2\]/,                     // Numbered selection

  // Selection box with prompt
  /╰─+╯\s*>\s*$/,                     // Box bottom + prompt
];


export interface ActivityDetectorOptions {
  bufferSize?: number;        // Max buffer size (default: 1000)
  debounceMs?: number;        // Debounce time (default: 300ms)
  onStateChange?: (state: ClaudeActivityState) => void;
}

export class ActivityDetector {
  private buffer: string = '';
  private bufferSize: number;
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private currentState: ClaudeActivityState = 'idle';
  private onStateChange?: (state: ClaudeActivityState) => void;
  private lastOutputTime: number = 0;

  // User typing detection
  private userTyping: boolean = false;
  private userTypingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly userTypingTimeoutMs: number = 5000;

  // Rate-based detection: track output over sliding time windows
  private outputHistory: { time: number }[] = [];
  // Time window for rate calculation (ms)
  private readonly rateWindowMs: number = 2000;
  // Threshold: number of outputs in window to consider "active"
  private readonly activeCountThreshold: number = 20;
  // How long with no output to transition to idle (ms)
  private readonly noOutputIdleMs: number = 2000;

  constructor(options: ActivityDetectorOptions = {}) {
    this.bufferSize = options.bufferSize ?? 1000;
    this.debounceMs = options.debounceMs ?? 300;
    this.onStateChange = options.onStateChange;
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
      console.log(`[ActivityDetector] Received output (${cleanData.length} chars): ${JSON.stringify(cleanData)}`);
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

    console.log(`[ActivityDetector] Output count: ${outputCount} in ${this.rateWindowMs}ms window`);

    // Count-based state transitions (skip if user is typing)
    if (outputCount >= this.activeCountThreshold && !this.userTyping) {
      // High output count → active (even from asking state)
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
        console.log(`[ActivityDetector] Idle check: ${timeSinceLastOutput}ms since last output`);

        if (timeSinceLastOutput >= this.noOutputIdleMs && this.currentState === 'active') {
          this.setState('idle');
        }
      }, this.noOutputIdleMs + 100); // Check slightly after the threshold
    }
  }

  /**
   * Check if any asking pattern matches the buffer
   */
  private hasAskingPattern(text: string): boolean {
    for (const pattern of ASKING_PATTERNS) {
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

    // Idle detection is handled by scheduleIdleCheck() (5 seconds no output)
  }

  /**
   * Set state and notify if changed
   */
  private setState(newState: ClaudeActivityState): void {
    if (this.currentState !== newState) {
      console.log(`[ActivityDetector] State change: ${this.currentState} → ${newState}`);
      this.currentState = newState;

      // Clear output history when entering asking state
      // (UI redraws during asking should not count towards active detection)
      if (newState === 'asking') {
        this.outputHistory = [];
      }

      this.onStateChange?.(newState);
    }
  }

  /**
   * Get current detected state
   */
  getState(): ClaudeActivityState {
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
      console.log(`[ActivityDetector] User typing: ON (history cleared)`);
    } else {
      console.log(`[ActivityDetector] User typing: ON`);
    }

    // Clear existing timer
    if (this.userTypingTimer) {
      clearTimeout(this.userTypingTimer);
    }

    // Set timeout to clear typing flag
    this.userTypingTimer = setTimeout(() => {
      this.userTyping = false;
      this.userTypingTimer = null;
      console.log(`[ActivityDetector] User typing: OFF (timeout)`);
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
   */
  clearUserTyping(): void {
    this.userTyping = false;
    console.log(`[ActivityDetector] User typing: OFF (submit)`);

    // Clear existing timer
    if (this.userTypingTimer) {
      clearTimeout(this.userTypingTimer);
      this.userTypingTimer = null;
    }

    // Always transition to idle first, let processOutput() handle active transition
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
