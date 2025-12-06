# Claude Code Web Console - 設計書

## 概要

複数のgit worktreeで動作するClaude Codeインスタンスを、ブラウザから一元管理するWebアプリケーション。
git worktreeの作成・削除もUIから行える。

## 背景・動機

### 問題
- 複数worktreeを作成し、各ターミナルでClaude Codeを起動する運用
- ターミナルが分散し、どのworktreeで何が起きているか把握しづらい
- ステータス表示だけのWeb UIでは、該当ターミナルへの「ジャンプ」ができない
- git worktreeコマンドは便利だが、利用時の入力が煩雑

### 解決策
- バックエンドがClaude Codeプロセスを直接管理
- ブラウザからxterm.jsで操作
- ターミナルを使わず、完全Web化
- git worktreeの作成・削除もUIから実行

## 技術スタック

- **パッケージ管理**: pnpm workspaces
- **バックエンド**: Node.js + TypeScript + Hono + @hono/node-ws
- **フロントエンド**: React + TypeScript + Vite + TanStack Router (file-based) + TanStack Query (Suspense)
- **テスト**: Vitest（各フェーズでモジュールごとにユニットテスト）
- **共通**: 型定義の共有

## アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│  バックエンド（Node.js + Hono 常駐サーバー）      │
│                                                 │
│  repositories: Map<id, Repository>              │
│  sessions: Map<id, Session>                     │
│  ├── Session1: { pty, outputBuffer, ... }       │
│  ├── Session2: { pty, outputBuffer, ... }       │
│  └── Session3: { pty, outputBuffer, ... }       │
│                                                 │
│  HTTP Server (ポート 3457)                       │
│  WebSocket Server (terminal / dashboard)        │
└─────────────────────────────────────────────────┘
          ↕ WebSocket / REST API
┌─────────────────────────────────────────────────┐
│  フロントエンド（React + Vite）                   │
│                                                 │
│  - 統合ダッシュボード（全リポジトリ/セッション）    │
│  - xterm.js でターミナル表示                     │
│  - TanStack Router でURLルーティング             │
│  - TanStack Query でAPI/WebSocket状態管理        │
└─────────────────────────────────────────────────┘
```

## 主要な設計判断

### 1. 複数リポジトリ対応
- UIから複数のベースリポジトリを登録・管理
- 統合ダッシュボードで全リポジトリのworktree/セッションを一覧表示
- リポジトリ由来を明示

### 2. git worktree統合
- worktreeの作成・削除をUIから実行
- worktree作成時に自動でClaude Codeセッション開始（オプション）
- worktree削除時はセッション強制終了オプションあり

### 3. プロセス管理
- **バックエンドがプロセスを保持**: タブを閉じてもClaude Codeは動き続ける
- **tmux的な役割**: サーバーが動いている限りプロセスは生存
- **出力バッファリング**: 再接続時に過去の出力を表示

### 4. UI方式
- **URLベースのルーティング**: `/sessions/:id` でターミナルにアクセス
- ダッシュボード（`/`）から各セッションへ遷移

## データ構造

### Repository
```typescript
interface Repository {
  id: string;           // UUID
  name: string;         // 表示名（ディレクトリ名）
  path: string;         // 絶対パス
  registeredAt: string; // 登録日時
}
```

### Worktree
```typescript
interface Worktree {
  path: string;         // worktreeの絶対パス
  branch: string;       // ブランチ名
  head: string;         // HEADコミットハッシュ
  isMain: boolean;      // メインworktreeか
  repositoryId: string; // 親リポジトリID
}
```

### Session
```typescript
interface Session {
  id: string;           // UUID
  worktreePath: string; // worktreeパス（cwd）
  repositoryId: string; // 親リポジトリID
  status: 'running' | 'idle' | 'stopped';
  pid?: number;
  startedAt: string;
}
```

### WebSocket メッセージ

**ターミナル用 - Client → Server:**
```typescript
{ type: 'input', data: string }
{ type: 'resize', cols: number, rows: number }
```

**ターミナル用 - Server → Client:**
```typescript
{ type: 'output', data: string }
{ type: 'exit', exitCode: number, signal: string | null }
{ type: 'history', data: string }  // 再接続時
```

**ダッシュボード用 - Server → Client:**
```typescript
{ type: 'session-created', session: Session }
{ type: 'session-updated', session: Session }
{ type: 'session-deleted', sessionId: string }
{ type: 'worktree-created', worktree: Worktree }
{ type: 'worktree-deleted', worktreePath: string }
{ type: 'repository-added', repository: Repository }
{ type: 'repository-removed', repositoryId: string }
```

## API設計

### リポジトリ
```
GET    /api/repositories           - 登録済みリポジトリ一覧
POST   /api/repositories           - リポジトリ登録
DELETE /api/repositories/:id       - リポジトリ登録解除
```

### Worktree
```
GET    /api/repositories/:id/worktrees      - worktree一覧
POST   /api/repositories/:id/worktrees      - worktree作成
DELETE /api/repositories/:id/worktrees/:path - worktree削除
GET    /api/repositories/:id/branches       - ブランチ一覧
```

### セッション
```
GET    /api/sessions        - セッション一覧
POST   /api/sessions        - セッション開始
DELETE /api/sessions/:id    - セッション終了
```

### WebSocket
```
WS /ws/terminal/:sessionId  - ターミナル接続
WS /ws/dashboard            - ダッシュボード通知
```

## URL設計（フロントエンド）

```
/                      - ダッシュボード（全リポジトリ/セッション一覧）
/sessions/:sessionId   - ターミナル画面
```

## 実装ロードマップ

### Phase 0: プロジェクトセットアップ
- [ ] pnpm workspace設定
- [ ] TypeScript設定
- [ ] shared パッケージの型定義
- [ ] server パッケージの雛形
- [ ] client パッケージの雛形

### Phase 1: 単一セッション動作確認 (PoC相当)
- [x] node-ptyでClaude Code起動 (PoC完了)
- [x] WebSocketで出力転送 (PoC完了)
- [x] xterm.jsで表示 (PoC完了)
- [ ] TypeScript/React版で再実装

### Phase 2: 複数セッション管理
- [ ] sessions Mapで複数管理
- [ ] 出力バッファリング
- [ ] 再接続時の履歴表示
- [ ] タブを閉じてもプロセス維持
- [ ] REST API実装

### Phase 3: ダッシュボード + git worktree統合
- [ ] リポジトリ登録/管理UI
- [ ] worktree一覧表示
- [ ] worktree作成UI（ブランチ選択/新規作成）
- [ ] worktree削除UI（強制削除オプション）
- [ ] セッション状態表示
- [ ] WebSocketリアルタイム通知

### Phase 4: 発展機能（将来）
- [ ] 通知機能（Claude Codeが待機状態になったら等）
- [ ] タスクステータス統合
- [ ] セッションのグループ化/タグ付け

## プロジェクト構造

```
agent-console/
├── package.json              # ワークスペースルート
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── shared/               # 共通型定義
│   ├── server/               # バックエンド (Hono)
│   └── client/               # フロントエンド (React + Vite)
├── poc/                      # PoCファイル（参照用）
├── design.md
└── CLAUDE.md
```

## 技術的注意点

- Claude CodeはインタラクティブTUIなので、通常のspawnではなくPTYが必要
- ANSIエスケープシーケンスはxterm.jsが解釈
- リサイズイベントはPTY側にも伝える必要がある

## 参考プロジェクト

### vibe-kanban (BloopAI)
- https://github.com/BloopAI/vibe-kanban
- Rust + TypeScript/React
- 複数AIエージェント（Claude Code, Gemini CLI等）を管理
- Git Worktreeを活用

### 本プロジェクトとの違い
- vibe-kanban: フル機能のカンバンボード、複雑なUI
- 本プロジェクト: シンプルなターミナルアクセス + git worktree管理
