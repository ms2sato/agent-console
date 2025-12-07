// ========== Agent ==========
export * from './types/agent.js';

// ========== リポジトリ ==========
export interface Repository {
  id: string;           // UUID
  name: string;         // 表示名（ディレクトリ名）
  path: string;         // 絶対パス
  registeredAt: string; // 登録日時（ISO 8601）
}

// ========== Worktree ==========
export interface Worktree {
  path: string;         // worktreeの絶対パス
  branch: string;       // ブランチ名（gitから動的取得）
  isMain: boolean;      // メインworktreeか
  repositoryId: string; // 親リポジトリID
  index?: number;       // 連番（1から。メインには割り当てない）
}

// ========== セッション ==========
export type SessionStatus = 'running' | 'idle' | 'stopped';

// Claude Code の活動状態（出力パースで検出）
export type ClaudeActivityState =
  | 'active'    // 作業中（出力継続）
  | 'idle'      // 待機中（プロンプト表示）
  | 'asking'    // 質問待ち（AskUserQuestion / 許可プロンプト）
  | 'unknown';  // 不明

export interface Session {
  id: string;           // UUID
  worktreePath: string; // worktreeパス（cwd）
  repositoryId: string; // 親リポジトリID
  status: SessionStatus;
  activityState?: ClaudeActivityState; // Claude Code の活動状態
  pid?: number;
  startedAt: string;    // ISO 8601
  agentId?: string;     // 使用するAgent ID（未指定時はデフォルトAgent）
  branch: string;       // ブランチ名（セッション開始時に取得）
}

// ========== WebSocket メッセージ ==========
// ターミナル用（セッション個別接続）
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'image'; data: string; mimeType: string }; // base64 encoded image

export type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal: string | null }
  | { type: 'history'; data: string }
  | { type: 'activity'; state: ClaudeActivityState };

// ダッシュボード用（全体通知）
export type DashboardServerMessage =
  | { type: 'sessions-sync'; sessions: Array<{ id: string; activityState: ClaudeActivityState }> }
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'session-activity'; sessionId: string; activityState: ClaudeActivityState }
  | { type: 'worktree-created'; worktree: Worktree }
  | { type: 'worktree-deleted'; worktreePath: string }
  | { type: 'repository-added'; repository: Repository }
  | { type: 'repository-removed'; repositoryId: string };

// ========== API リクエスト/レスポンス ==========
export interface CreateRepositoryRequest {
  path: string;
}

export interface CreateWorktreeRequest {
  branch: string;           // 既存ブランチ名 or 新規ブランチ名
  baseBranch?: string;      // 新規ブランチの場合のベース
  autoStartSession?: boolean;
  agentId?: string;         // autoStartSession時に使用するAgent ID
}

export interface DeleteWorktreeRequest {
  force?: boolean;          // セッション強制終了して削除
}

export interface CreateSessionRequest {
  worktreePath: string;
  repositoryId: string;
  agentId?: string;         // 使用するAgent ID（未指定時はデフォルトAgent）
}

// ========== API レスポンス ==========
export interface ApiError {
  error: string;
  message: string;
}
