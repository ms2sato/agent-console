import type { WSContext } from 'hono/ws';
import type { TerminalClientMessage, TerminalServerMessage } from '@agents-web-console/shared';
import { sessionManager } from '../services/session-manager.js';

export function handleTerminalConnection(
  ws: WSContext,
  sessionId: string
): void {
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    const errorMsg: TerminalServerMessage = {
      type: 'exit',
      exitCode: 1,
      signal: null,
    };
    ws.send(JSON.stringify(errorMsg));
    ws.close();
    return;
  }

  console.log(`Terminal WebSocket connected for session: ${sessionId}`);

  // Send buffered output (history) on reconnection
  const history = sessionManager.getOutputBuffer(sessionId);
  if (history) {
    const historyMsg: TerminalServerMessage = {
      type: 'history',
      data: history,
    };
    ws.send(JSON.stringify(historyMsg));
  }
}

export function handleTerminalMessage(
  _ws: WSContext,
  sessionId: string,
  message: string | ArrayBuffer
): void {
  try {
    const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const parsed: TerminalClientMessage = JSON.parse(msgStr);

    switch (parsed.type) {
      case 'input':
        sessionManager.writeInput(sessionId, parsed.data);
        break;
      case 'resize':
        sessionManager.resize(sessionId, parsed.cols, parsed.rows);
        break;
    }
  } catch (e) {
    console.error('Invalid terminal message:', e);
  }
}

export function createSessionWithWebSocket(
  ws: WSContext,
  worktreePath: string,
  repositoryId: string
): string {
  const session = sessionManager.createSession(
    worktreePath,
    repositoryId,
    (data) => {
      const msg: TerminalServerMessage = { type: 'output', data };
      ws.send(JSON.stringify(msg));
    },
    (exitCode, signal) => {
      const msg: TerminalServerMessage = { type: 'exit', exitCode, signal };
      ws.send(JSON.stringify(msg));
    }
  );

  return session.id;
}
