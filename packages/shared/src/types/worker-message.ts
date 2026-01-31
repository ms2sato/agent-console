/**
 * Inter-worker message types for multi-agent communication.
 *
 * Workers can send messages to other workers within the same session
 * by outputting a specific delimiter pattern. The server detects these
 * patterns and injects the message into the target worker's PTY input.
 *
 * Delimiter format in agent output:
 *   <<<TO:worker-name>>>message content<<<END>>>
 *
 * Injection format into target PTY:
 *   [From worker-name]: message content\n
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
