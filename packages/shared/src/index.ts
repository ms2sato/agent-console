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
  branch: string;       // ブランチ名
  head: string;         // HEADコミットハッシュ
  isMain: boolean;      // メインworktreeか
  repositoryId: string; // 親リポジトリID
}

// ========== セッション ==========
export type SessionStatus = 'running' | 'idle' | 'stopped';

export interface Session {
  id: string;           // UUID
  worktreePath: string; // worktreeパス（cwd）
  repositoryId: string; // 親リポジトリID
  status: SessionStatus;
  pid?: number;
  startedAt: string;    // ISO 8601
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
  | { type: 'history'; data: string };

// ダッシュボード用（全体通知）
export type DashboardServerMessage =
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  | { type: 'session-deleted'; sessionId: string }
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
}

export interface DeleteWorktreeRequest {
  force?: boolean;          // セッション強制終了して削除
}

export interface CreateSessionRequest {
  worktreePath: string;
  repositoryId: string;
}

// ========== API レスポンス ==========
export interface ApiError {
  error: string;
  message: string;
}
