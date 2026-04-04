/**
 * Types for the interactive process feature.
 *
 * Interactive processes are in-memory volatile — they disappear on server restart.
 * Agents use interactive processes to run scripts that drive workflow via STDOUT,
 * while the agent responds via STDIN — separating workflow control from knowledge work.
 */

export type InteractiveProcessStatus = 'running' | 'exited';

export interface InteractiveProcessInfo {
  id: string;
  sessionId: string;
  workerId: string;
  command: string;
  status: InteractiveProcessStatus;
  startedAt: string;
  exitCode?: number;
}
