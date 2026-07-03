import type { AgentActivityState } from '@agent-console/shared';

/**
 * The terminal component contract, rescued from the deleted legacy
 * `components/Terminal.tsx` when the labs renderer became the sole terminal
 * (roadmap PR-5). `TerminalAdapter` implements these props; `SessionPage`,
 * `sessionStatus`, and `status-mapping` consume the types.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'exited';

export interface TerminalProps {
  sessionId: string;
  workerId: string;
  onStatusChange?: (status: ConnectionStatus, exitInfo?: { code: number; signal: string | null }) => void;
  onActivityChange?: (state: AgentActivityState) => void;
  onRequestRestart?: (continueConversation: boolean) => void;
  onResumeSession?: () => void;
  onFilesReceived?: (files: File[]) => void;
  hideStatusBar?: boolean;
  stripScrollbackClear?: boolean;
}
