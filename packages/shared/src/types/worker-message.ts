/**
 * Inter-worker message types for multi-agent communication.
 *
 * Users can send messages to workers within the same session
 * via the MessagePanel UI. The server injects the message content
 * directly into the target worker's PTY input.
 */

export interface WorkerMessage {
  id: string;
  sessionId: string;
  fromWorkerId: string;
  fromWorkerName: string;
  toWorkerId: string;
  toWorkerName: string;
  content: string;
  timestamp: string;  // ISO 8601
}
