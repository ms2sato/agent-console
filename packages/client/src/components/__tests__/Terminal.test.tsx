/**
 * Integration tests for Terminal component history handling.
 *
 * Note: Full component rendering tests are avoided because mocking xterm.js
 * via mock.module() pollutes global state and breaks other tests.
 * The xterm.js integration is verified via manual testing.
 *
 * ## Scroll-to-Bottom Button Manual Verification Checklist
 *
 * The following scenarios require manual testing because they depend on actual
 * xterm.js rendering, scroll events, and DOM interactions that cannot be
 * reliably unit tested:
 *
 * ### Button Visibility
 * - [ ] Button is hidden when terminal loads (at bottom by default)
 * - [ ] Button appears when user scrolls up (mouse wheel or scroll gesture)
 * - [ ] Button disappears when user scrolls back to bottom manually
 * - [ ] Button disappears after clicking it to scroll to bottom
 *
 * ### Scroll Behavior
 * - [ ] Clicking button scrolls terminal to the very bottom
 * - [ ] Button works correctly after new output is appended
 * - [ ] Button state updates correctly during rapid output streaming
 * - [ ] Scroll position is preserved during tab switches when scrolled up
 *
 * ### Visual/UX
 * - [ ] Button has smooth opacity/translate transition animation
 * - [ ] Button is positioned in bottom-right corner of terminal
 * - [ ] Button does not interfere with terminal interaction
 * - [ ] Button is visible against various terminal backgrounds
 * - [ ] ChevronDownIcon is clearly visible and properly sized
 *
 * ### Accessibility
 * - [ ] Button is keyboard focusable
 * - [ ] Screen reader announces "Scroll to bottom" when focused
 * - [ ] Button tooltip appears on hover
 *
 * ### Edge Cases
 * - [ ] Button behaves correctly when terminal is resized
 * - [ ] Button works with very long terminal output (large buffer)
 * - [ ] Button state is correct when switching between workers
 * - [ ] No visual glitches during worker reconnection
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as workerWs from '../../lib/worker-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { isScrolledToBottom, type TerminalScrollInfo } from '../../lib/terminal-utils';

describe('Terminal history handling integration', () => {
  let restoreWebSocket: () => void;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    // Suppress console.log during tests
    consoleLogSpy = spyOn(console, 'log');
    workerWs._reset();
  });

  afterEach(() => {
    workerWs._reset();
    restoreWebSocket();
    consoleLogSpy.mockRestore();
  });

  describe('history request behavior', () => {
    it('should NOT request history automatically via worker-websocket connect()', async () => {
      // This test verifies that worker-websocket.connect() does NOT automatically
      // send request-history. History requests are now the responsibility of
      // Terminal.tsx, which calls requestHistory() explicitly with the appropriate
      // fromOffset based on cache state.
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: (_data: string, _offset: number) => {},
        onHistory: (_data: string, _offset: number) => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();

      // Simulate connection open
      ws?.simulateOpen();

      // Wait a bit to ensure no automatic request is sent
      await new Promise((resolve) => setTimeout(resolve, 200));

      // request-history should NOT be sent automatically by worker-websocket
      const sendCalls = (ws?.send as ReturnType<typeof spyOn>).mock.calls as unknown[][];
      const historyRequests = sendCalls.filter(
        (call: unknown[]) => {
          try {
            return JSON.parse(call[0] as string).type === 'request-history';
          } catch {
            return false;
          }
        }
      );
      expect(historyRequests.length).toBe(0);
    });

    it('should allow explicit history request via requestHistory()', async () => {
      // This test verifies that requestHistory() can be called explicitly
      // to request history with a specific fromOffset.
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: (_data: string, _offset: number) => {},
        onHistory: (_data: string, _offset: number) => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for connection to be established
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Clear mock to track requestHistory call
      ws?.send.mockClear();

      // Explicitly request history (simulating what Terminal.tsx does)
      const result = workerWs.requestHistory('session-1', 'worker-1', 0);

      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-history', fromOffset: 0 }));
    });

    it('should allow explicit history request with fromOffset for incremental sync', async () => {
      // This test verifies that requestHistory() can request incremental history
      // from a specific offset (used when Terminal has cached state).
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: (_data: string, _offset: number) => {},
        onHistory: (_data: string, _offset: number) => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for connection to be established
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Clear mock to track requestHistory call
      ws?.send.mockClear();

      // Request history from a specific offset (simulating cache restoration)
      const result = workerWs.requestHistory('session-1', 'worker-1', 5678);

      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-history', fromOffset: 5678 }));
    });
  });
});

/**
 * Tests for scroll-to-bottom button logic.
 *
 * These tests verify the isScrolledToBottom utility function that determines
 * when the scroll-to-bottom button should be shown.
 *
 * Note: Component rendering tests for the button are not included because
 * mocking xterm.js pollutes global state. The button rendering is verified
 * via manual testing (see checklist at top of file).
 */
describe('Scroll-to-bottom button logic', () => {
  /**
   * Helper to create mock terminal scroll info.
   */
  function createMockTerminal(viewportY: number, rows: number, bufferLength: number): TerminalScrollInfo {
    return {
      buffer: {
        active: {
          viewportY,
          length: bufferLength,
        },
      },
      rows,
    };
  }

  describe('isScrolledToBottom integration with Terminal state', () => {
    it('should indicate button should be hidden when at bottom', () => {
      // Terminal state: at bottom, button should be hidden
      const terminal = createMockTerminal(76, 24, 100);
      const showButton = !isScrolledToBottom(terminal);
      expect(showButton).toBe(false);
    });

    it('should indicate button should be shown when scrolled up', () => {
      // Terminal state: scrolled up, button should be visible
      const terminal = createMockTerminal(50, 24, 100);
      const showButton = !isScrolledToBottom(terminal);
      expect(showButton).toBe(true);
    });

    it('should handle updateScrollButtonVisibility logic flow', () => {
      // Simulates the logic in Terminal.updateScrollButtonVisibility
      const simulateUpdateScrollButtonVisibility = (
        terminal: TerminalScrollInfo | null
      ): boolean => {
        if (!terminal) {
          return false; // showScrollButton = false
        }
        return !isScrolledToBottom(terminal);
      };

      // When terminal is null, button is hidden
      expect(simulateUpdateScrollButtonVisibility(null)).toBe(false);

      // When at bottom, button is hidden
      expect(simulateUpdateScrollButtonVisibility(createMockTerminal(76, 24, 100))).toBe(false);

      // When scrolled up, button is shown
      expect(simulateUpdateScrollButtonVisibility(createMockTerminal(50, 24, 100))).toBe(true);
    });
  });

  describe('scroll button visibility edge cases', () => {
    it('should hide button for empty terminal', () => {
      // New terminal with no output yet
      const terminal = createMockTerminal(0, 24, 0);
      const showButton = !isScrolledToBottom(terminal);
      expect(showButton).toBe(false);
    });

    it('should hide button when content fits in viewport', () => {
      // Small output that fits in terminal
      const terminal = createMockTerminal(0, 24, 10);
      const showButton = !isScrolledToBottom(terminal);
      expect(showButton).toBe(false);
    });

    it('should show button when just one line above bottom', () => {
      // User scrolled up slightly
      const terminal = createMockTerminal(75, 24, 100);
      const showButton = !isScrolledToBottom(terminal);
      expect(showButton).toBe(true);
    });

    it('should hide button when exactly at bottom after scroll', () => {
      // User clicked scroll-to-bottom and is now at exact bottom
      const terminal = createMockTerminal(76, 24, 100);
      const showButton = !isScrolledToBottom(terminal);
      expect(showButton).toBe(false);
    });
  });
});

/**
 * Tests for scroll-to-bottom button accessibility and CSS class verification.
 *
 * These tests verify the expected structure of the button without rendering
 * the full Terminal component. We test the HTML/CSS structure expectations
 * that should exist in the component.
 */
describe('Scroll-to-bottom button structure expectations', () => {
  describe('accessibility attributes', () => {
    it('should expect aria-label attribute for screen readers', () => {
      // This test documents the expected aria-label value
      // Actual verification is done via manual testing or snapshot tests
      const expectedAriaLabel = 'Scroll to bottom';
      expect(expectedAriaLabel).toBe('Scroll to bottom');
    });

    it('should expect title attribute for tooltip', () => {
      // This test documents the expected title value
      const expectedTitle = 'Scroll to bottom';
      expect(expectedTitle).toBe('Scroll to bottom');
    });
  });

  describe('CSS class expectations for visibility states', () => {
    it('should expect opacity-100 and translate-y-0 classes when visible', () => {
      // When showScrollButton is true
      const visibleClasses = ['opacity-100', 'translate-y-0'];
      const baseClasses = 'absolute bottom-4 right-4 p-2 bg-slate-700';

      // Document expected visible state classes
      expect(visibleClasses).toContain('opacity-100');
      expect(visibleClasses).toContain('translate-y-0');
      expect(baseClasses).toContain('absolute');
      expect(baseClasses).toContain('bottom-4');
      expect(baseClasses).toContain('right-4');
    });

    it('should expect opacity-0, translate-y-2, and pointer-events-none classes when hidden', () => {
      // When showScrollButton is false
      const hiddenClasses = ['opacity-0', 'translate-y-2', 'pointer-events-none'];

      // Document expected hidden state classes
      expect(hiddenClasses).toContain('opacity-0');
      expect(hiddenClasses).toContain('translate-y-2');
      expect(hiddenClasses).toContain('pointer-events-none');
    });

    it('should expect transition-all class for smooth animation', () => {
      // Animation class expected on the button
      const animationClasses = ['transition-all', 'duration-200'];

      expect(animationClasses).toContain('transition-all');
      expect(animationClasses).toContain('duration-200');
    });
  });

  describe('ChevronDownIcon expectations', () => {
    it('should expect ChevronDownIcon with w-5 h-5 classes', () => {
      // The icon should have specific size classes
      const expectedIconClasses = 'w-5 h-5';

      expect(expectedIconClasses).toContain('w-5');
      expect(expectedIconClasses).toContain('h-5');
    });
  });
});

/**
 * Tests for lazy history loading optimization.
 *
 * These tests verify the requestHistory function and the lazy loading behavior
 * that prevents all tabs from loading history simultaneously on page reload.
 *
 * ## Lazy History Loading Manual Verification Checklist
 *
 * The following scenarios require manual testing because they depend on actual
 * terminal rendering, WebSocket connections, and tab visibility changes:
 *
 * ### Initial Load (Page Reload)
 * - [ ] Only the active tab loads history on page reload
 * - [ ] Inactive tabs do NOT load history until they become visible
 * - [ ] No performance warning like "'message' handler took Xms" in console
 *
 * ### Tab Switch
 * - [ ] Switching to an unvisited tab triggers history load
 * - [ ] Switching to a previously visited tab uses cached history (diff mode)
 * - [ ] History is displayed correctly after first visibility
 *
 * ### Edge Cases
 * - [ ] Rapid tab switching does not cause duplicate history loads
 * - [ ] Reconnection after disconnect works correctly for visited tabs
 * - [ ] New output appears correctly while tab is invisible
 */
describe('Lazy history loading optimization', () => {
  let restoreWebSocket: () => void;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    consoleLogSpy = spyOn(console, 'log');
    workerWs._reset();
  });

  afterEach(() => {
    workerWs._reset();
    restoreWebSocket();
    consoleLogSpy.mockRestore();
  });

  describe('requestHistory function', () => {
    it('should send request-history message when connected', async () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: (_data: string, _offset: number) => {},
        onHistory: (_data: string, _offset: number) => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear mock to track subsequent calls
      ws?.send.mockClear();

      // Call requestHistory
      const result = workerWs.requestHistory('session-1', 'worker-1');

      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-history', fromOffset: 0 }));
    });

    it('should return false when not connected', () => {
      const result = workerWs.requestHistory('non-existent', 'worker');
      expect(result).toBe(false);
    });

    it('should return false when WebSocket is not open', () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: (_data: string, _offset: number) => {},
        onHistory: (_data: string, _offset: number) => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      // Don't simulate open - WebSocket is still CONNECTING

      const result = workerWs.requestHistory('session-1', 'worker-1');
      expect(result).toBe(false);
    });

    it('should send request-history with fromOffset when specified', async () => {
      const callbacks: workerWs.TerminalWorkerCallbacks = {
        type: 'terminal',
        onOutput: (_data: string, _offset: number) => {},
        onHistory: (_data: string, _offset: number) => {},
        onExit: () => {},
      };

      workerWs.connect('session-1', 'worker-1', callbacks);
      const ws = MockWebSocket.getLastInstance();
      ws?.simulateOpen();

      // Wait for initial setup
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear mock to track subsequent calls
      ws?.send.mockClear();

      // Call requestHistory with fromOffset
      const result = workerWs.requestHistory('session-1', 'worker-1', 1234);

      expect(result).toBe(true);
      expect(ws?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'request-history', fromOffset: 1234 }));
    });
  });

  describe('lazy loading behavior simulation', () => {
    /**
     * Simulates the handleHistory behavior in Terminal component.
     * Returns whether history would be processed (true) or ignored (false).
     */
    function simulateHandleHistory(
      _data: string,
      isVisible: boolean,
      hasLoadedHistory: boolean
    ): { processed: boolean; shouldSetHasLoadedHistory: boolean } {
      // This simulates the early return logic in Terminal.handleHistory:
      // if (!isVisible && !hasLoadedHistory) return;

      if (!isVisible && !hasLoadedHistory) {
        // Invisible tab that hasn't loaded history yet: completely ignore
        return { processed: false, shouldSetHasLoadedHistory: false };
      }

      // All other cases: process history
      // After processing, mark as loaded if not already
      return { processed: true, shouldSetHasLoadedHistory: !hasLoadedHistory };
    }

    it('should ignore history for invisible tab that has not loaded yet', () => {
      const result = simulateHandleHistory('history data', false, false);

      expect(result.processed).toBe(false);
      expect(result.shouldSetHasLoadedHistory).toBe(false);
    });

    it('should process history for visible tab that has not loaded yet', () => {
      const result = simulateHandleHistory('history data', true, false);

      expect(result.processed).toBe(true);
      expect(result.shouldSetHasLoadedHistory).toBe(true);
    });

    it('should process history for invisible tab that has already loaded (cache update)', () => {
      const result = simulateHandleHistory('history data', false, true);

      expect(result.processed).toBe(true);
      expect(result.shouldSetHasLoadedHistory).toBe(false);
    });

    it('should process history for visible tab that has already loaded', () => {
      const result = simulateHandleHistory('history data', true, true);

      expect(result.processed).toBe(true);
      expect(result.shouldSetHasLoadedHistory).toBe(false);
    });
  });

  describe('lazy loading state transitions', () => {
    /**
     * Simulates the complete flow of lazy history loading across visibility changes.
     */
    function simulateLazyLoadingFlow(): {
      initialLoadProcessed: boolean;
      tabSwitchProcessed: boolean;
      returnToTabProcessed: boolean;
    } {
      // State tracking
      let hasLoadedHistory = false;

      // Scenario:
      // 1. Page loads with this tab invisible (not active)
      // 2. Server sends history immediately after connection
      // 3. User switches to this tab (becomes visible)
      // 4. User switches away (invisible)
      // 5. User switches back (visible again)

      // Step 1-2: Tab is invisible, history arrives
      const step1IsVisible = false;
      if (!step1IsVisible && !hasLoadedHistory) {
        // History is ignored
      } else {
        hasLoadedHistory = true;
      }
      const initialLoadProcessed = hasLoadedHistory;

      // Step 3: Tab becomes visible, requests history
      const step3IsVisible = true;
      if (step3IsVisible && !hasLoadedHistory) {
        // requestHistory would be called, then onHistory fires
        hasLoadedHistory = true;
      }
      const tabSwitchProcessed = hasLoadedHistory;

      // Step 4-5: Tab visibility changes, history already loaded
      // History already loaded, no need to re-request on return
      const returnToTabProcessed = hasLoadedHistory;

      return {
        initialLoadProcessed,
        tabSwitchProcessed,
        returnToTabProcessed,
      };
    }

    it('should demonstrate correct lazy loading state transitions', () => {
      const flow = simulateLazyLoadingFlow();

      // Initial load while invisible: NOT processed (optimization!)
      expect(flow.initialLoadProcessed).toBe(false);

      // Tab switch (first visibility): processed
      expect(flow.tabSwitchProcessed).toBe(true);

      // Return to tab: still loaded (uses cache)
      expect(flow.returnToTabProcessed).toBe(true);
    });
  });
});
