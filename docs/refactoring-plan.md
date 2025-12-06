# Refactoring Plan for agent-console

## Overview

基本機能完成後のコード品質改善計画。テストを先に入れてからリファクタリングを行う。

## Phase 1: Add Tests (Priority 1)

### Step 1.1: Server Unit Tests (3-4時間)

**対象:**
- `packages/server/src/services/__tests__/activity-detector.test.ts`
- `packages/server/src/services/__tests__/persistence-service.test.ts`
- `packages/server/src/services/__tests__/repository-manager.test.ts`

**ActivityDetector Tests (最重要 - 複雑な状態機械):**
- 状態遷移テスト: idle -> active -> idle
- asking パターン検出テスト
- デバウンス動作テスト
- ユーザータイピングフラグテスト

### Step 1.2: Server Integration Tests (2-3時間)

**対象:** `packages/server/src/__tests__/api.test.ts`

Hono の app.request() を使ったAPIテスト:
- GET/POST/DELETE /api/sessions
- GET/POST/DELETE /api/repositories
- GET/POST/DELETE /api/repositories/:id/worktrees

### Step 1.3: Client Unit Tests (2時間)

**対象:** `packages/client/src/lib/__tests__/api.test.ts`

- 正常レスポンステスト
- エラーレスポンス処理テスト
- ServerUnavailableError テスト

---

## Phase 2: Split index.ts (Priority 2)

### 現状 (533行)
```
Lines 1-17:    Imports
Lines 18-25:   App setup, middleware
Lines 28-133:  Session API routes
Lines 135-171: Repository API routes
Lines 173-291: Worktree API routes
Lines 293-341: Dashboard WebSocket handler
Lines 343-408: Terminal WebSocket (existing session)
Lines 411-468: Terminal WebSocket (new session)
Lines 470-520: Shell WebSocket handler
Lines 522-533: Server startup
```

### 目標構造 (4-5時間)

```
packages/server/src/
├── index.ts (~50行 - エントリポイントのみ)
├── routes/
│   ├── sessions.ts      (~80行)
│   ├── repositories.ts  (~50行)
│   └── worktrees.ts     (~100行)
├── websocket/
│   ├── terminal-handler.ts (既存)
│   ├── dashboard-handler.ts (新規 ~60行)
│   └── shell-handler.ts     (新規 ~60行)
└── services/ (変更なし)
```

### Step 2.1-2.2: Create Route Files

```typescript
// routes/sessions.ts
import { Hono } from 'hono';
import { sessionManager } from '../services/session-manager.js';

export const sessionRoutes = new Hono();

sessionRoutes.get('/', (c) => { ... });
sessionRoutes.post('/', async (c) => { ... });
// etc.
```

### Step 2.3-2.5: Extract WebSocket Handlers

```typescript
// websocket/dashboard-handler.ts
export function setupDashboardWebSocket(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket
): void {
  const clients = new Set<WSContext>();
  // ...
}
```

---

## Phase 3: Unify Error Handling (Priority 3)

### 現状の問題

**Pattern A (JSON抽出あり):**
```typescript
const error = await res.json().catch(() => ({ error: res.statusText }));
throw new Error(error.error || 'Failed to create session');
```

**Pattern B (statusTextのみ):**
```typescript
throw new Error(`Failed to fetch config: ${res.statusText}`);
```

### 解決策 (2時間)

**Step 3.1: Create API Error Utilities**

```typescript
// packages/client/src/lib/api-error.ts
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: { error: string }
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function handleApiResponse<T>(
  res: Response,
  operation: string
): Promise<T> {
  if (res.status >= 500) {
    throw new ServerUnavailableError();
  }

  if (!res.ok) {
    let errorMessage = res.statusText;
    try {
      const errorBody = await res.json();
      errorMessage = errorBody.error || errorMessage;
    } catch {
      // JSON parse失敗時はstatusText使用
    }
    throw new ApiError(`${operation}: ${errorMessage}`, res.status);
  }

  return res.json();
}
```

**Step 3.2: Update All API Functions**

```typescript
// Before
export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${API_BASE}/config`);
  if (!res.ok) {
    throw new Error(`Failed to fetch config: ${res.statusText}`);
  }
  return res.json();
}

// After
export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(`${API_BASE}/config`);
  return handleApiResponse(res, 'Failed to fetch config');
}
```

---

## Implementation Order

| Phase | Task | 所要時間 | 依存関係 |
|-------|------|---------|---------|
| 1.1 | Server unit tests | 3-4時間 | なし |
| 1.2 | Server integration tests | 2-3時間 | なし |
| 1.3 | Client unit tests | 2時間 | なし |
| 2.1-2.7 | Split index.ts | 4-5時間 | Phase 1 |
| 3.1-3.3 | Unify error handling | 2時間 | Phase 1 |

**合計見積もり:** 13-16時間

---

## Verification Checklist

各フェーズ完了後:
- [ ] 全テストパス (`pnpm test`)
- [ ] TypeScript コンパイル成功 (`pnpm typecheck`)
- [ ] 主要機能の手動テスト
- [ ] ブラウザコンソールにエラーなし
