import type { WorkerMessage } from '@agent-console/shared';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('message-service');

const MAX_MESSAGES_PER_SESSION = 200;

/**
 * MessageService - Manages inter-worker message history per session.
 * Messages are stored in-memory (not persisted across server restarts).
 */
export class MessageService {
  private messagesBySession = new Map<string, WorkerMessage[]>();

  addMessage(message: WorkerMessage): void {
    let messages = this.messagesBySession.get(message.sessionId);
    if (!messages) {
      messages = [];
      this.messagesBySession.set(message.sessionId, messages);
    }
    messages.push(message);

    // Trim old messages
    if (messages.length > MAX_MESSAGES_PER_SESSION) {
      messages.splice(0, messages.length - MAX_MESSAGES_PER_SESSION);
    }

    logger.info(
      { sessionId: message.sessionId, from: message.fromWorkerName, to: message.toWorkerName },
      'Worker message recorded'
    );
  }

  getMessages(sessionId: string): WorkerMessage[] {
    return [...(this.messagesBySession.get(sessionId) ?? [])];
  }

  clearSession(sessionId: string): void {
    this.messagesBySession.delete(sessionId);
  }
}
