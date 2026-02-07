import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SdkWorkerView } from '../SdkWorkerView';
import { MockWebSocket, installMockWebSocket } from '../../../test/mock-websocket';
import { _reset } from '../../../lib/worker-websocket';
import type { SDKMessage } from '@agent-console/shared';

describe('SdkWorkerView', () => {
  let restoreWebSocket: () => void;

  beforeEach(() => {
    restoreWebSocket = installMockWebSocket();
    _reset();
  });

  afterEach(() => {
    _reset();
    restoreWebSocket();
    cleanup();
  });

  const setupConnected = () => {
    const ws = MockWebSocket.getLastInstance();
    act(() => {
      ws?.simulateOpen();
    });
    return ws;
  };

  describe('connection status display', () => {
    it('should show "Connecting..." when not connected', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      expect(screen.getByText('Connecting...')).toBeTruthy();
    });

    it('should show "Disconnected" indicator when not connected', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      expect(screen.getByText('Disconnected')).toBeTruthy();
    });

    it('should hide "Disconnected" indicator when connected', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      setupConnected();

      expect(screen.queryByText('Disconnected')).toBeNull();
    });

    it('should show "No messages yet" when connected with no messages', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      setupConnected();

      expect(screen.getByText('No messages yet. Send a message to start.')).toBeTruthy();
    });

    it('should call onStatusChange when connection state changes', () => {
      const onStatusChange = mock(() => {});
      render(
        <SdkWorkerView
          sessionId="session-1"
          workerId="worker-1"
          onStatusChange={onStatusChange}
        />
      );

      const ws = MockWebSocket.getLastInstance();
      act(() => {
        ws?.simulateOpen();
      });

      expect(onStatusChange).toHaveBeenCalledWith('connected');

      act(() => {
        ws?.simulateClose();
      });

      expect(onStatusChange).toHaveBeenCalledWith('disconnected');
    });
  });

  describe('message rendering', () => {
    it('should render user messages', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      const userMessage: SDKMessage = {
        type: 'user',
        uuid: 'msg-1',
        message: { content: 'Hello, assistant!' },
      };

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sdk-message', message: userMessage })
        );
      });

      expect(screen.getByText('Hello, assistant!')).toBeTruthy();
    });

    it('should render assistant messages with text blocks', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      const assistantMessage: SDKMessage = {
        type: 'assistant',
        uuid: 'msg-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, user! How can I help you today?' }],
        },
      };

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sdk-message', message: assistantMessage })
        );
      });

      expect(screen.getByText('Hello, user! How can I help you today?')).toBeTruthy();
    });

    it('should render result messages with completion status', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      const resultMessage: SDKMessage = {
        type: 'result',
        uuid: 'msg-3',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        total_cost_usd: 0.0123,
        num_turns: 3,
      };

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sdk-message', message: resultMessage })
        );
      });

      // Text may be split across elements, so use a function matcher
      expect(screen.getByText((content) => content.includes('Completed'))).toBeTruthy();
      expect(screen.getByText(/3\s*turn/)).toBeTruthy();
      expect(screen.getByText(/5\.0\s*s/)).toBeTruthy();
      expect(screen.getByText(/\$0\.0123/)).toBeTruthy();
    });

    it('should render error result messages', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      const errorResult: SDKMessage = {
        type: 'result',
        uuid: 'msg-4',
        is_error: true,
        subtype: 'error',
      };

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sdk-message', message: errorResult })
        );
      });

      // Text may be split across elements, so use a function matcher
      expect(screen.getByText((content) => content.includes('Error'))).toBeTruthy();
    });
  });

  describe('processing indicator', () => {
    it('should show processing indicator when activity state is active', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      // First send a user message
      const userMessage: SDKMessage = {
        type: 'user',
        uuid: 'msg-1',
        message: { content: 'Help me with something' },
      };

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({ type: 'sdk-message', message: userMessage })
        );
      });

      // Then receive activity state change
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
      });

      expect(screen.getByText('Processing...')).toBeTruthy();
    });

    it('should call onActivityChange when activity state changes', () => {
      const onActivityChange = mock(() => {});
      render(
        <SdkWorkerView
          sessionId="session-1"
          workerId="worker-1"
          onActivityChange={onActivityChange}
        />
      );

      const ws = setupConnected();

      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
      });

      expect(onActivityChange).toHaveBeenCalledWith('active');

      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'idle' }));
      });

      expect(onActivityChange).toHaveBeenCalledWith('idle');
    });
  });

  describe('stop button integration', () => {
    it('should show stop button when sending', async () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      // Trigger active state to show stop button
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      });
    });

    it('should call cancelQuery when stop button is clicked', async () => {
      const user = userEvent.setup();
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      // Trigger active state to show stop button
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
      });

      const stopButton = await screen.findByRole('button', { name: 'Stop' });
      await user.click(stopButton);

      // Verify cancel message was sent
      expect(ws?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'cancel' })
      );
    });
  });

  describe('error display', () => {
    it('should display WebSocket errors', () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'error',
            message: 'Worker activation failed',
            code: 'WORKER_NOT_FOUND',
          })
        );
      });

      expect(screen.getByText('Worker activation failed')).toBeTruthy();
      expect(screen.getByText('(WORKER_NOT_FOUND)')).toBeTruthy();
    });
  });

  describe('exit event handling', () => {
    it('should reset sending state when exit event is received', async () => {
      const onStatusChange = mock(() => {});
      render(
        <SdkWorkerView
          sessionId="session-1"
          workerId="worker-1"
          onStatusChange={onStatusChange}
        />
      );

      const ws = setupConnected();

      // Start in active/sending state
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
      });

      // Stop button should be visible
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      });

      // Receive exit event
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'exit', exitCode: 1, signal: null }));
      });

      // Should call onStatusChange with 'exited'
      expect(onStatusChange).toHaveBeenCalledWith('exited');

      // Send button should be visible (not Stop) because sending was reset
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
      });
    });
  });

  describe('message history', () => {
    it('should reset sending state when message-history is received (reconnect scenario)', async () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      // Start in active/sending state
      act(() => {
        ws?.simulateMessage(JSON.stringify({ type: 'activity', state: 'active' }));
      });

      // Stop button should be visible
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      });

      // Receive message-history (simulating reconnect after server restart)
      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'message-history',
            messages: [],
            lastUuid: null,
          })
        );
      });

      // Send button should be visible (not Stop) because sending was reset
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
      });
    });

    it('should render messages from history', async () => {
      render(<SdkWorkerView sessionId="session-1" workerId="worker-1" />);

      const ws = setupConnected();

      const historyMessages: SDKMessage[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          message: { content: 'First message' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response to first message' }],
          },
        },
      ];

      act(() => {
        ws?.simulateMessage(
          JSON.stringify({
            type: 'message-history',
            messages: historyMessages,
            lastUuid: 'msg-2',
          })
        );
      });

      expect(screen.getByText('First message')).toBeTruthy();
      expect(screen.getByText('Response to first message')).toBeTruthy();
    });
  });
});
