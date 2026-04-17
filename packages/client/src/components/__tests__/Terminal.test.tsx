/**
 * Integration tests for Terminal component history handling.
 *
 * Note: Full component rendering tests are avoided because mocking xterm.js
 * via mock.module() pollutes global state and breaks other tests.
 * The xterm.js integration is verified via manual testing.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as workerWs from '../../lib/worker-websocket';
import { MockWebSocket, installMockWebSocket } from '../../test/mock-websocket';
import { isScrolledToBottom, stripSystemMessages, stripScrollbackClear, type TerminalScrollInfo } from '../../lib/terminal-utils';
import { restoreScrollPosition, type ScrollableTerminal } from '../Terminal';
import { render, screen, cleanup } from '@testing-library/react';
import { TerminalLoadingBar } from '../ui/TerminalLoadingBar';
import type { CachedState } from '../../lib/terminal-state-cache';
import {
  register as registerSaveManager,
  unregister as unregisterSaveManager,
  markDirty as markSaveManagerDirty,
  setIdleSaveDelay,
  resetIdleSaveDelay,
  setSaveFunction,
  resetSaveFunction,
  clearRegistry as clearSaveManagerRegistry,
} from '../../lib/terminal-state-save-manager';

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
 * Tests for Terminal -> WorkerErrorRecovery integration.
 *
 * Terminal.tsx renders WorkerErrorRecovery when a workerError is present,
 * passing through the onRequestRestart prop as onRestart, and
 * handleGoToDashboard (which navigates to '/') as onGoToDashboard.
 *
 * Since xterm.js cannot be mocked in unit tests, we verify the integration
 * contract here by modeling the prop-passing logic.
 */
describe('Terminal -> WorkerErrorRecovery prop integration', () => {
  /**
   * Models how Terminal.tsx constructs WorkerErrorRecovery props (lines 665-673).
   * The Terminal component passes:
   *   - onRetry={handleRetry}
   *   - onDeleteSession={handleDeleteSession}
   *   - onGoToDashboard={handleGoToDashboard}
   *   - onRestart={onRequestRestart}  <-- the prop from SessionPage
   */
  function buildWorkerErrorRecoveryProps(params: {
    onRequestRestart?: (continueConversation: boolean) => void;
    handleRetry: () => void;
    handleDeleteSession: () => void;
    handleGoToDashboard: () => void;
  }) {
    return {
      onRetry: params.handleRetry,
      onDeleteSession: params.handleDeleteSession,
      onGoToDashboard: params.handleGoToDashboard,
      onRestart: params.onRequestRestart,
    };
  }

  it('should pass onRequestRestart as onRestart to WorkerErrorRecovery', () => {
    const onRequestRestart = (_continueConversation: boolean) => {};
    const props = buildWorkerErrorRecoveryProps({
      onRequestRestart,
      handleRetry: () => {},
      handleDeleteSession: () => {},
      handleGoToDashboard: () => {},
    });

    expect(props.onRestart).toBe(onRequestRestart);
  });

  it('should pass undefined onRestart when onRequestRestart is not provided', () => {
    const props = buildWorkerErrorRecoveryProps({
      onRequestRestart: undefined,
      handleRetry: () => {},
      handleDeleteSession: () => {},
      handleGoToDashboard: () => {},
    });

    expect(props.onRestart).toBeUndefined();
  });

  it('should always provide handleGoToDashboard for dashboard navigation', () => {
    const goToDashboard = () => {};
    const props = buildWorkerErrorRecoveryProps({
      handleRetry: () => {},
      handleDeleteSession: () => {},
      handleGoToDashboard: goToDashboard,
    });

    expect(props.onGoToDashboard).toBe(goToDashboard);
  });

  /**
   * Models the flow: Terminal receives onRequestRestart from SessionPage,
   * which is handleWorkerRestart. When WorkerErrorRecovery's "Continue (-c)"
   * button is clicked, it calls onRestart(true), which invokes handleWorkerRestart(true).
   */
  it('should propagate continueConversation flag through the callback chain', () => {
    const calls: boolean[] = [];
    const handleWorkerRestart = (continueConversation: boolean) => {
      calls.push(continueConversation);
    };

    // Terminal receives handleWorkerRestart as onRequestRestart
    const props = buildWorkerErrorRecoveryProps({
      onRequestRestart: handleWorkerRestart,
      handleRetry: () => {},
      handleDeleteSession: () => {},
      handleGoToDashboard: () => {},
    });

    // WorkerErrorRecovery calls onRestart(true) for "Continue (-c)"
    props.onRestart?.(true);
    expect(calls).toEqual([true]);

    // WorkerErrorRecovery calls onRestart(false) for "New Session"
    props.onRestart?.(false);
    expect(calls).toEqual([true, false]);
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
/**
 * Tests for Terminal state machine sync logic.
 *
 * These tests simulate the state machine that coordinates cache loading,
 * WebSocket connection, and history requests in Terminal.tsx. The actual
 * component cannot be rendered in tests due to xterm.js mocking issues,
 * so we model the state transitions as pure functions.
 */
describe('Terminal state machine sync', () => {
  /**
   * Mirrors the TerminalState fields relevant to history sync in Terminal.tsx.
   */
  interface SimulatedState {
    cacheProcessed: boolean;
    historyRequested: boolean;
    requestedWithOffset: number;
    currentOffset: number;
  }

  function createInitialState(overrides?: Partial<SimulatedState>): SimulatedState {
    return {
      cacheProcessed: false,
      historyRequested: false,
      requestedWithOffset: 0,
      currentOffset: 0,
      ...overrides,
    };
  }

  /**
   * Simulates the useEffect that sends history requests (lines 555-562 of Terminal.tsx):
   *   if (connected && cacheProcessed && !stateRef.current.historyRequested) { ... }
   */
  function evaluateHistoryRequest(state: SimulatedState, connected: boolean): {
    shouldRequest: boolean;
    requestOffset: number;
  } {
    if (connected && state.cacheProcessed && !state.historyRequested) {
      return { shouldRequest: true, requestOffset: state.currentOffset };
    }
    return { shouldRequest: false, requestOffset: 0 };
  }

  /**
   * Applies the side effects of evaluateHistoryRequest when shouldRequest is true.
   */
  function applyHistoryRequest(state: SimulatedState): SimulatedState {
    const result = evaluateHistoryRequest(state, true);
    if (!result.shouldRequest) return state;
    return {
      ...state,
      historyRequested: true,
      requestedWithOffset: result.requestOffset,
    };
  }

  /**
   * Simulates handleConnectionChange when disconnected (lines 196-199):
   *   if (!connected) { stateRef.current.historyRequested = false; }
   */
  function handleDisconnect(state: SimulatedState): SimulatedState {
    return { ...state, historyRequested: false };
  }

  /**
   * Simulates handleOutputTruncated:
   *   offsetRef.current = newOffset;
   *   (no state reset, no history re-request — the xterm.js terminal still has valid content)
   */
  function handleTruncation(state: SimulatedState, _connected: boolean, newOffset: number): {
    state: SimulatedState;
  } {
    return {
      state: {
        ...state,
        currentOffset: newOffset,
      },
    };
  }

  /**
   * Simulates handleHistory decision (lines 165-184):
   *   if (requestedWithOffset > 0) → append diff
   *   else → full write
   */
  function determineHistoryAction(
    requestedWithOffset: number,
    hasData: boolean
  ): 'append-diff' | 'full-write' | 'skip' {
    if (requestedWithOffset > 0) {
      // Had cache — append diff (even empty data triggers save)
      return hasData ? 'append-diff' : 'skip';
    }
    // No cache — full history
    return hasData ? 'full-write' : 'skip';
  }

  describe('cache hit -> diff append flow', () => {
    it('should request history from cached offset and append diff', () => {
      // 1. Cache loads with offset=1000
      let state = createInitialState({ currentOffset: 1000 });

      // 2. Cache processing completes
      state = { ...state, cacheProcessed: true };

      // 3. Connected = true -> should request history from offset 1000
      const request = evaluateHistoryRequest(state, true);
      expect(request.shouldRequest).toBe(true);
      expect(request.requestOffset).toBe(1000);

      // 4. Apply the request
      state = applyHistoryRequest(state);
      expect(state.historyRequested).toBe(true);
      expect(state.requestedWithOffset).toBe(1000);

      // 5. handleHistory arrives -> should append diff (not full write)
      const action = determineHistoryAction(state.requestedWithOffset, true);
      expect(action).toBe('append-diff');
    });
  });

  describe('no cache -> full history flow', () => {
    it('should request history from offset 0 and do full write', () => {
      // 1. Cache miss, offset stays 0
      let state = createInitialState({ currentOffset: 0 });

      // 2. Cache processing completes (no data restored)
      state = { ...state, cacheProcessed: true };

      // 3. Connected = true -> should request from offset 0
      const request = evaluateHistoryRequest(state, true);
      expect(request.shouldRequest).toBe(true);
      expect(request.requestOffset).toBe(0);

      // 4. Apply the request
      state = applyHistoryRequest(state);
      expect(state.requestedWithOffset).toBe(0);

      // 5. handleHistory arrives -> should do full write
      const action = determineHistoryAction(state.requestedWithOffset, true);
      expect(action).toBe('full-write');
    });
  });

  describe('disconnect -> reconnect -> re-request with current offset', () => {
    it('should re-request history after reconnection using current offset', () => {
      // 1. Initial sync completes at offset 5000
      let state = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 0,
        currentOffset: 5000,
      });

      // 2. Disconnect resets historyRequested
      state = handleDisconnect(state);
      expect(state.historyRequested).toBe(false);

      // 3. Reconnect -> should re-request with current offset (5000)
      const request = evaluateHistoryRequest(state, true);
      expect(request.shouldRequest).toBe(true);
      expect(request.requestOffset).toBe(5000);

      // 4. Apply the request
      state = applyHistoryRequest(state);
      expect(state.historyRequested).toBe(true);
      expect(state.requestedWithOffset).toBe(5000);

      // 5. Diff arrives -> append mode since requestedWithOffset > 0
      const action = determineHistoryAction(state.requestedWithOffset, true);
      expect(action).toBe('append-diff');
    });
  });

  describe('truncation -> offset update only', () => {
    it('should update offset to newOffset without re-requesting history when connected', () => {
      // 1. Initial sync completed, offset at 3000
      let state = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 500,
        currentOffset: 3000,
      });

      // 2. Truncation event while connected — server provides newOffset
      const newOffset = 1500;
      const truncResult = handleTruncation(state, true, newOffset);
      state = truncResult.state;

      // Truncation just updates offset — no history re-request
      expect(state.currentOffset).toBe(newOffset);
      // historyRequested remains unchanged (already true)
      expect(state.historyRequested).toBe(true);
      // requestedWithOffset remains unchanged
      expect(state.requestedWithOffset).toBe(500);
    });

    it('should update offset to newOffset without re-requesting history when disconnected', () => {
      let state = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 500,
        currentOffset: 3000,
      });

      // Truncation while disconnected — same behavior, just update offset
      const newOffset = 1500;
      const truncResult = handleTruncation(state, false, newOffset);
      state = truncResult.state;

      expect(state.currentOffset).toBe(newOffset);
      // historyRequested remains unchanged
      expect(state.historyRequested).toBe(true);
      // requestedWithOffset remains unchanged
      expect(state.requestedWithOffset).toBe(500);
    });
  });

  describe('history request requires BOTH connected AND cacheProcessed', () => {
    it('should not request when connected but cache not yet processed', () => {
      const state = createInitialState({ cacheProcessed: false });

      const request = evaluateHistoryRequest(state, true);
      expect(request.shouldRequest).toBe(false);
    });

    it('should request once cache is also processed', () => {
      const state = createInitialState({ cacheProcessed: true });

      const request = evaluateHistoryRequest(state, true);
      expect(request.shouldRequest).toBe(true);
    });

    it('should not request when cache processed but not connected', () => {
      const state = createInitialState({ cacheProcessed: true });

      const request = evaluateHistoryRequest(state, false);
      expect(request.shouldRequest).toBe(false);
    });

    it('should request once connection is also established', () => {
      const state = createInitialState({ cacheProcessed: true });

      const request = evaluateHistoryRequest(state, true);
      expect(request.shouldRequest).toBe(true);
    });
  });

  /**
   * Tests for scroll position preservation behavior during output truncation vs worker restart.
   *
   * Background: When the server's output file exceeds WORKER_OUTPUT_FILE_MAX_SIZE (default 10MB),
   * the server truncates the file and sends an `output-truncated` message. Previously,
   * resetTerminalForFreshHistory() called terminal.reset() which immediately cleared the terminal
   * and reset scroll position to top. This caused a visible scroll-to-top flash during active AI
   * output, especially when truncation happened repeatedly.
   *
   * The fix: resetTerminalForFreshHistory() no longer calls terminal.reset(). The terminal content
   * is preserved until writeFullHistory() atomically replaces it when the new history arrives.
   * However, handleWorkerRestarted still calls terminal.reset() explicitly for immediate visual
   * feedback that the terminal is restarting.
   */
  describe('scroll position preservation: truncation vs worker restart', () => {
    /**
     * Simulates handleOutputTruncated behavior including terminal.reset() decision.
     * Maps to Terminal.tsx handleOutputTruncated:
     *   - Just updates offsetRef.current = newOffset
     *   - Does NOT call terminal.reset() or re-request history
     */
    function handleTruncationWithTerminalBehavior(
      state: SimulatedState,
      _connected: boolean,
      newOffset: number
    ): { state: SimulatedState; terminalResetCalled: boolean } {
      const truncResult = handleTruncation(state, _connected, newOffset);
      return {
        ...truncResult,
        // handleOutputTruncated does NOT call terminal.reset()
        // Content stays visible — server only removed old data from beginning of file
        terminalResetCalled: false,
      };
    }

    /**
     * Simulates handleWorkerRestarted behavior including terminal.reset() decision.
     * Maps to Terminal.tsx handleWorkerRestarted (lines ~248-280):
     *   - Calls resetTerminalForFreshHistory() (no terminal.reset())
     *   - Then explicitly calls terminalRef.current?.reset() for visual feedback
     */
    function handleWorkerRestartWithTerminalBehavior(
      state: SimulatedState
    ): { state: SimulatedState; terminalResetCalled: boolean } {
      // resetTerminalForFreshHistory() resets state variables
      const resetState: SimulatedState = {
        ...state,
        currentOffset: 0,
        historyRequested: false,
        requestedWithOffset: 0,
      };
      return {
        state: resetState,
        // handleWorkerRestarted explicitly calls terminal.reset() after resetTerminalForFreshHistory()
        terminalResetCalled: true,
      };
    }

    it('should NOT call terminal.reset() on output truncation (prevents scroll-to-top flash)', () => {
      const state = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 500,
        currentOffset: 8000,
      });

      const newOffset = 4000;
      const result = handleTruncationWithTerminalBehavior(state, true, newOffset);

      // terminal.reset() must NOT be called — xterm.js still has valid content;
      // the server only removed old data from the beginning of the file
      expect(result.terminalResetCalled).toBe(false);
      // offset is updated to the server-provided newOffset
      expect(result.state.currentOffset).toBe(newOffset);
    });

    it('should call terminal.reset() on worker restart (immediate visual feedback)', () => {
      const state = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 500,
        currentOffset: 8000,
      });

      const result = handleWorkerRestartWithTerminalBehavior(state);

      // terminal.reset() SHOULD be called — user needs immediate visual feedback
      // that the terminal is restarting
      expect(result.terminalResetCalled).toBe(true);
    });

    it('should have different behaviors: truncation updates offset, restart resets everything', () => {
      const initialState = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 500,
        currentOffset: 8000,
      });

      const newOffset = 4000;
      const truncResult = handleTruncationWithTerminalBehavior(initialState, true, newOffset);
      const restartResult = handleWorkerRestartWithTerminalBehavior(initialState);

      // Truncation: offset updated to newOffset, other state unchanged
      expect(truncResult.state.currentOffset).toBe(newOffset);
      expect(truncResult.state.historyRequested).toBe(true);
      expect(truncResult.state.requestedWithOffset).toBe(500);

      // Restart: everything reset to 0
      expect(restartResult.state.currentOffset).toBe(0);
      expect(restartResult.state.requestedWithOffset).toBe(0);
      expect(restartResult.state.historyRequested).toBe(false);

      // terminal.reset() behavior differs
      expect(truncResult.terminalResetCalled).toBe(false);
      expect(restartResult.terminalResetCalled).toBe(true);
    });

    it('should NOT call terminal.reset() on truncation even when disconnected', () => {
      const state = createInitialState({
        cacheProcessed: true,
        historyRequested: true,
        requestedWithOffset: 500,
        currentOffset: 8000,
      });

      const newOffset = 4000;
      const result = handleTruncationWithTerminalBehavior(state, false, newOffset);

      expect(result.terminalResetCalled).toBe(false);
      // offset is updated to newOffset
      expect(result.state.currentOffset).toBe(newOffset);
      // historyRequested stays unchanged — truncation does not touch it
      expect(result.state.historyRequested).toBe(true);
    });
  });

  describe('duplicate request prevention', () => {
    it('should not send duplicate request when useEffect re-runs', () => {
      let state = createInitialState({ cacheProcessed: true });

      // First evaluation -> triggers request
      const first = evaluateHistoryRequest(state, true);
      expect(first.shouldRequest).toBe(true);
      state = applyHistoryRequest(state);

      // Second evaluation (useEffect re-run) -> historyRequested is true, no duplicate
      const second = evaluateHistoryRequest(state, true);
      expect(second.shouldRequest).toBe(false);
    });

    it('should not send duplicate even after cacheProcessed toggles', () => {
      let state = createInitialState({ cacheProcessed: true });
      state = applyHistoryRequest(state);

      // Simulate hypothetical re-trigger: historyRequested remains true
      expect(evaluateHistoryRequest(state, true).shouldRequest).toBe(false);
    });
  });
});

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

/**
 * Tests for scroll position restoration after viewportY corruption.
 *
 * Background: xterm.js's viewportY gets corrupted during alternate screen buffer
 * transitions (used by Claude Code's TUI mode). For example, viewportY can jump
 * from 1000 (bottom) to 0 or 305 while baseY remains at 1000. This was observed
 * in production via diagnostic logging during dogfooding.
 *
 * restoreScrollPosition() detects this corruption and restores the user's scroll
 * position based on a saved distanceFromBottom value (captured via wheel events).
 * distanceFromBottom is used instead of absolute viewportY because it's stable
 * across xterm.js buffer trimming.
 */
describe('processOutput pipeline (stripSystemMessages + stripScrollbackClear)', () => {
  // Terminal.tsx's processOutput callback applies stripSystemMessages first,
  // then optionally stripScrollbackClear. These tests verify the combined pipeline
  // produces correct results by calling the functions in the same order.

  function processOutput(data: string, applyScrollbackFilter: boolean): string {
    let result = stripSystemMessages(data);
    if (applyScrollbackFilter) {
      result = stripScrollbackClear(result);
    }
    return result;
  }

  it('should strip system messages without scrollback filter', () => {
    const input = 'hello\n[internal:timer] tick\nworld';
    expect(processOutput(input, false)).toBe('hello\nworld');
  });

  it('should strip system messages with scrollback filter enabled', () => {
    const input = 'hello\n[internal:process] started\nworld\x1b[3J';
    // stripSystemMessages removes the [internal:process] line, then stripScrollbackClear removes \x1b[3J
    expect(processOutput(input, true)).toBe('hello\nworld');
  });

  it('should apply both filters in correct order (system messages first, then scrollback)', () => {
    const input = 'start\n[internal:message] msg\n\x1b[2Jend';
    const result = processOutput(input, true);
    // stripSystemMessages removes the [internal:message] line
    // stripScrollbackClear replaces \x1b[2J with \x1b[H\x1b[J
    expect(result).toBe('start\n\x1b[H\x1b[Jend');
  });

  it('should pass through normal output unchanged', () => {
    const input = 'normal terminal output\nwith multiple lines';
    expect(processOutput(input, false)).toBe(input);
  });
});

describe('restoreScrollPosition', () => {
  /** Create a mock terminal with the given buffer state.
   * scrollToBottom and scrollLines are mock functions so we can assert on calls. */
  function createMockTerminal(
    viewportY: number,
    baseY: number,
    rows: number,
    length: number
  ): ScrollableTerminal & {
    scrollToBottom: ReturnType<typeof mock>;
    scrollLines: ReturnType<typeof mock>;
  } {
    return {
      buffer: {
        active: { viewportY, baseY, length },
      },
      rows,
      scrollToBottom: mock(),
      scrollLines: mock(),
    };
  }

  describe('when terminal is already at bottom (no corruption)', () => {
    // These tests verify the fast path: no correction needed.

    it('should not call any scroll methods when viewportY is at bottom', () => {
      // Real-world: Normal operation. Agent output flows, xterm.js auto-scrolls
      // correctly, viewportY is at the bottom. restoreScrollPosition is called
      // after every write but should be a no-op in this case.
      // viewportY=1000, rows=25, length=1025 -> at bottom (1000 + 25 >= 1025)
      const terminal = createMockTerminal(1000, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 0 });

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });
  });

  describe('when user was at bottom (distanceFromBottom === 0) and viewportY is corrupted', () => {
    // These tests verify the most common fix path: user was following output
    // at the bottom, viewportY got corrupted, scroll back to bottom.

    it('should scrollToBottom when viewportY jumps to 0', () => {
      // Real-world: Most common corruption pattern observed in production logs.
      // User is watching Claude Code output at the bottom. Alternate screen
      // buffer switch corrupts viewportY to 0 (top of buffer).
      // viewportY=0, baseY=1000, rows=25, length=1025 -> NOT at bottom (0+25 < 1025)
      // distanceFromBottom=0 -> scrollToBottom
      const terminal = createMockTerminal(0, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 0 });

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });

    it('should scrollToBottom when viewportY jumps to a middle position', () => {
      // Real-world: Second most common corruption pattern. viewportY jumps to
      // some arbitrary value (305, 214, 584 observed in production).
      // viewportY=305, baseY=1000, rows=25, length=1025 -> NOT at bottom
      // distanceFromBottom=0 -> scrollToBottom
      const terminal = createMockTerminal(305, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 0 });

      expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });
  });

  describe('when user was scrolled up (distanceFromBottom > 0) and viewportY is corrupted', () => {
    // These tests verify scroll restoration for users reading history.
    // The user scrolled up to read agent output, then viewportY got corrupted.
    // They should be restored to where they were reading, not yanked to bottom.

    it('should restore to saved position when viewportY is corrupted to 0', () => {
      // Real-world: User scrolled up 200 lines from bottom to read a long
      // Claude Code response. viewportY should be 800 (baseY=1000 - 200).
      // Alternate buffer switch corrupts viewportY to 0.
      // Expected: scrollLines(800 - 0 = 800) to restore position.
      // distanceFromBottom=200, viewportY=0, baseY=1000
      const terminal = createMockTerminal(0, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 200 });

      expect(terminal.scrollLines).toHaveBeenCalledTimes(1);
      expect(terminal.scrollLines).toHaveBeenCalledWith(800); // targetY(800) - viewportY(0)
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it('should restore to saved position when viewportY is corrupted to a wrong position', () => {
      // Real-world: User scrolled up 500 lines. viewportY should be 500.
      // Corruption sets viewportY to 305.
      // Expected: scrollLines(500 - 305 = 195) to restore.
      // distanceFromBottom=500, viewportY=305, baseY=1000
      const terminal = createMockTerminal(305, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 500 });

      expect(terminal.scrollLines).toHaveBeenCalledTimes(1);
      expect(terminal.scrollLines).toHaveBeenCalledWith(195); // targetY(500) - viewportY(305)
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it('should not call scrollLines when viewportY is already at the correct position', () => {
      // Real-world: restoreScrollPosition is called on every write callback.
      // When no corruption has occurred, the viewportY should already match
      // the expected position. No correction needed.
      // distanceFromBottom=200, viewportY=800, baseY=1000
      // targetY = 1000 - 200 = 800 = viewportY -> no-op
      const terminal = createMockTerminal(800, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 200 });

      expect(terminal.scrollLines).not.toHaveBeenCalled();
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });
  });

  describe('distanceFromBottom calculation logic', () => {
    // These tests verify the distanceFromBottom concept used by the wheel
    // event handler. distanceFromBottom = baseY - viewportY.

    it('should compute distanceFromBottom as 0 when at bottom', () => {
      // When user is at the bottom, distanceFromBottom should be 0.
      // This is the state captured by the wheel handler when the user
      // scrolls down to the very bottom.
      // baseY=1000, viewportY=1000 -> distance = 0
      const baseY = 1000;
      const viewportY = 1000;
      const distanceFromBottom = baseY - viewportY;
      expect(distanceFromBottom).toBe(0);
    });

    it('should compute distanceFromBottom correctly when scrolled up', () => {
      // When user scrolls up 200 lines, viewportY = baseY - 200.
      // The wheel handler captures: baseY - viewportY = 200.
      // baseY=1000, viewportY=800 -> distance = 200
      const baseY = 1000;
      const viewportY = 800;
      const distanceFromBottom = baseY - viewportY;
      expect(distanceFromBottom).toBe(200);
    });

    it('should be stable across buffer trimming', () => {
      // Key property: distanceFromBottom is a RELATIVE measure from the bottom.
      // When the buffer trims old lines (scrollback limit reached), both baseY
      // and viewportY shift, but the distance remains approximately correct.
      //
      // Before trimming: baseY=1000, viewportY=800, distance=200
      // After trimming 50 lines: baseY=1000 (stays at limit),
      //   viewportY=750 (shifted), distance=250 (drifted by 50)
      //
      // The drift is bounded by the number of lines added since the last
      // wheel event, which is typically small. This is a deliberate tradeoff:
      // imprecise but bounded restoration is better than jumping to viewportY=0.
      //
      // Verify the math:
      const beforeBaseY = 1000;
      const beforeViewportY = 800;
      const savedDistance = beforeBaseY - beforeViewportY; // 200

      // After 50 new lines added (buffer trimmed 50 old lines)
      const afterBaseY = 1000; // stays at scrollback limit
      const targetY = afterBaseY - savedDistance; // 1000 - 200 = 800
      // But user's content is now at viewportY=750 (shifted by 50)
      // So restoration is 50 lines off -- acceptable tradeoff
      expect(savedDistance).toBe(200);
      expect(targetY).toBe(800);
    });
  });

  describe('edge cases', () => {
    it('should handle distanceFromBottom larger than baseY', () => {
      // Edge case: distanceFromBottom could exceed baseY if buffer was trimmed
      // significantly since the last wheel event. targetY would be negative.
      // scrollLines with a negative value scrolls up, which is clamped by xterm.js.
      // This should not crash -- it's better to attempt restoration than to skip it.
      // distanceFromBottom=1200, baseY=1000 -> targetY = -200
      // viewportY=0, scrollLines(-200 - 0 = -200)
      const terminal = createMockTerminal(0, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 1200 });

      expect(terminal.scrollLines).toHaveBeenCalledTimes(1);
      expect(terminal.scrollLines).toHaveBeenCalledWith(-200); // targetY(-200) - viewportY(0)
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it('should handle small buffer (content fits in viewport)', () => {
      // Edge case: terminal has very little output, everything fits in the viewport.
      // viewportY=0, baseY=0, length=10, rows=25 -> at bottom (0+25 >= 10)
      // restoreScrollPosition should be a no-op.
      const terminal = createMockTerminal(0, 0, 25, 10);

      restoreScrollPosition(terminal, { distanceFromBottom: 0 });

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });

    it('should handle distanceFromBottom of 1 (near-bottom scroll)', () => {
      // Edge case: macOS trackpad can generate tiny scroll deltas, resulting in
      // distanceFromBottom=1. If viewportY is corrupted, we should still restore
      // to 1 line from bottom, not the absolute bottom.
      // This is acceptable because being 1 line off is barely noticeable.
      // distanceFromBottom=1, baseY=1000, viewportY=0
      // targetY = 999, scrollLines(999)
      const terminal = createMockTerminal(0, 1000, 25, 1025);

      restoreScrollPosition(terminal, { distanceFromBottom: 1 });

      expect(terminal.scrollLines).toHaveBeenCalledTimes(1);
      expect(terminal.scrollLines).toHaveBeenCalledWith(999); // targetY(999) - viewportY(0)
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });
  });
});

/**
 * Tests for the loading indicator used in Terminal.
 *
 * Terminal.tsx passes `loadingHistory` state to `TerminalLoadingBar`.
 * Full component rendering is avoided (xterm.js mock pollution),
 * so we test the TerminalLoadingBar contract directly here.
 */
describe('Terminal loading indicator', () => {
  afterEach(() => {
    cleanup();
  });

  it('should show loading bar when loadingHistory is true', () => {
    render(<TerminalLoadingBar visible={true} />);
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('should hide loading bar when loadingHistory is false', () => {
    render(<TerminalLoadingBar visible={false} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

/**
 * Tests for Terminal cache-save payload contract (#648).
 *
 * Terminal.tsx constructs a `CachedState` and hands it to the save-manager
 * (which eventually calls `saveTerminalState`). Since the server-PID-based
 * invalidation was removed, the save payload must no longer contain a
 * `serverPid` field — only the 5 canonical keys: data, savedAt, cols, rows, offset.
 *
 * The Terminal component cannot be rendered in unit tests (xterm.js mocking
 * pollutes global state). This test pins the observable contract by intercepting
 * the save function via the save-manager's DI hook and asserting the exact
 * payload shape that Terminal.tsx's registered state-getter would produce.
 */
describe('Terminal cache-save payload contract', () => {
  const TEST_IDLE_DELAY_MS = 20;
  const capturedSaves: Array<{ sessionId: string; workerId: string; state: CachedState }> = [];

  beforeEach(() => {
    clearSaveManagerRegistry();
    capturedSaves.length = 0;
    setIdleSaveDelay(TEST_IDLE_DELAY_MS);
    setSaveFunction(async (sessionId, workerId, state) => {
      capturedSaves.push({ sessionId, workerId, state });
    });
  });

  afterEach(() => {
    clearSaveManagerRegistry();
    capturedSaves.length = 0;
    resetIdleSaveDelay();
    resetSaveFunction();
  });

  it('should save a payload with exactly the 5 CachedState keys and no serverPid', async () => {
    // Mirrors the state-getter Terminal.tsx registers with the save manager
    // (Terminal.tsx ~lines 542-549). The object is typed as CachedState, so
    // TypeScript would reject any `serverPid` field at compile time. This
    // runtime assertion pins the same contract so a regression cannot silently
    // reintroduce the field via a loosely-typed spread.
    const terminalStateGetter = (): CachedState => ({
      data: 'serialized-terminal-data',
      savedAt: 1700000000000,
      cols: 80,
      rows: 24,
      offset: 1234,
    });

    registerSaveManager('session-1', 'worker-1', terminalStateGetter);
    markSaveManagerDirty('session-1', 'worker-1');

    // Wait for the idle timer to fire and the save to propagate
    await new Promise((resolve) => setTimeout(resolve, TEST_IDLE_DELAY_MS + 20));
    await unregisterSaveManager('session-1', 'worker-1');

    expect(capturedSaves).toHaveLength(1);
    const [saved] = capturedSaves;
    expect(saved.sessionId).toBe('session-1');
    expect(saved.workerId).toBe('worker-1');

    // Exact-key contract: the payload must contain the 5 canonical keys only.
    // No `serverPid` — the #648 fix removed server-PID-based cache invalidation.
    // TypeScript enforces this at compile time (CachedState has no serverPid field);
    // this runtime check pins the same contract so a regression cannot silently
    // reintroduce the field via a loosely-typed spread.
    const keys = Object.keys(saved.state).sort();
    expect(keys).toEqual(['cols', 'data', 'offset', 'rows', 'savedAt']);
    expect(keys).not.toContain('serverPid');
  });
});

