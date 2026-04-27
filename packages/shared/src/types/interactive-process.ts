/**
 * Types for the interactive process feature.
 *
 * Interactive processes are in-memory volatile — they disappear on server restart.
 * Agents use interactive processes to run scripts that drive workflow via STDOUT,
 * while the agent responds via STDIN — separating workflow control from knowledge work.
 */

export type InteractiveProcessStatus = 'running' | 'exited';

/**
 * Routing mode for interactive process I/O.
 *
 * - `'pty'` (default): script stdout is delivered as `[internal:process]` PTY
 *   notifications containing the full output, and `write_process_response`
 *   echoes the response content into the worker PTY.
 * - `'message'`: script stdout and `write_process_response` content are
 *   routed via inter-session message files to the calling agent
 *   (toSessionId/toWorkerId match the run_process invocation). The PTY
 *   receives only a brief notification with the message file path.
 *
 * Use `'message'` for long-paragraph interactive scripts to keep the
 * calling agent's conversation clean.
 */
export type InteractiveProcessOutputMode = 'pty' | 'message';

export interface InteractiveProcessInfo {
  id: string;
  sessionId: string;
  workerId: string;
  command: string;
  status: InteractiveProcessStatus;
  startedAt: string;
  exitCode?: number;
  outputMode: InteractiveProcessOutputMode;
}
