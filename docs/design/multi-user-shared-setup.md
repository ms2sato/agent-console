# Multi-User Shared Setup

## Context

Agent Console is currently single-user. When started by one OS user, all sessions, repositories, and PTY processes share that user's identity. The goal is to enable multiple OS users on the same machine to share a single server instance where each user works exactly as if they were logged in directly — with their own HOME, API keys, SSH keys, environment variables, and file permissions.

## Terminology

- **Server operator**: The person who installs, configures, and starts the Agent Console server. Responsible for sudoers configuration and repository setup.
- **User**: Anyone who accesses Agent Console via the browser (including the server operator). Authenticated by OS username and password in multi-user mode.

## Architecture Decisions

- **Two operating modes** — `AUTH_MODE` environment variable switches between `none` (single-user, default) and `multi-user`. All behavioral differences are determined by this single setting.
- **Dedicated service user + sudoers** — In multi-user mode, the server runs as a dedicated service user (e.g., `agentconsole`). PTY processes are spawned via `sudo -u <loginuser>` to run as the authenticated OS user. No root required.
- **`users` table with UUID primary key** — Provides stable identity across OS username changes. OS UID is stored for lookup, but the app's own UUID is used as foreign key from `sessions.created_by`. Also serves as the future home for per-user settings (e.g., env_vars overrides).
- **OS authentication** — Login with OS username + password. Validated via platform-specific commands (macOS: `dscl`, Linux: PAM).
- **JWT in httpOnly cookie** — Secret stored in `$AGENT_CONSOLE_HOME/jwt-secret` (persists across restarts).
- **`createdBy` is nullable** — Backwards-compatible with existing sessions (pre-multi-user). References `users.id` (UUID).
- **All sessions remain visible** — No server-side filtering. Client filters by user (localStorage-persisted preference).
- **Repositories are shared globally** — All registered repositories and their settings (env_vars, setup_command, default_agent, etc.) are shared across all users. Both the server operator and users can register repositories.

### Why This Approach (PTY User Isolation)

| Approach | Pros | Cons |
|----------|------|------|
| **Service user + sudoers** | No root risk, minimal privilege, full user isolation | Requires sudoers config |
| root + sudo | Simple | Entire server runs as root — any vulnerability compromises the system |
| SSH to localhost | No root needed | Desktop session resources inaccessible (MCP tools, Keychain, etc.) |
| Env var override only | Simplest | No real user isolation (UID unchanged, file permissions wrong) |

SSH was rejected because PTY sessions run in an SSH login session rather than a local process, which breaks tools that need desktop session resources (e.g., Chrome MCP, OS Keychain for git credentials).

## Operating Modes

The server behavior is controlled by the `AUTH_MODE` environment variable:

```bash
AUTH_MODE=none         # Default. Current single-user behavior.
AUTH_MODE=multi-user   # Multi-user mode with OS authentication.
```

### Behavioral Differences

| | `none` (default) | `multi-user` |
|---|---|---|
| Authentication | SingleUserMode (always returns server process user) | MultiUserMode (OS credential validation, JWT) |
| Login page | None (client skips based on `authMode` config) | Required |
| Auth middleware | Runs, but SingleUserMode always provides server process user | Runs, validates JWT cookie |
| PTY spawning | Direct: `sh -c '...'` with env in process options | `sudo -u <user> -i sh -c 'cd ... && export ...; ...'` |
| Session `createdBy` | Server process user's `users.id` (from SingleUserMode) | Authenticated user's `users.id` |
| `/api/config` homeDir | Server user's `homedir()` | Authenticated user's home |
| WebSocket auth | Middleware runs, SingleUserMode always passes | Middleware runs, validates JWT cookie |

### Structural Separation

Mode-dependent behavior is abstracted behind the `UserMode` interface — a single facade that encapsulates authentication, login, and PTY spawning. `createAppContext()` selects the implementation based on `AUTH_MODE`:

```
UserMode (interface)
├── SingleUserMode    # mode=none: Null Object — always returns server process user, direct PTY spawn
└── MultiUserMode     # mode=multi-user: OS auth + JWT, sudo -u PTY spawn
```

The mode decision is made once at startup in `createAppContext()`. All other code depends only on the `UserMode` interface, so no mode-checking logic is scattered throughout the codebase.

The auth middleware always runs in both modes. In `none` mode, `SingleUserMode` ensures `authUser` is always present on the Hono context (set to the server process user). This eliminates null checks for `authUser` throughout the codebase.

The client learns the mode from `GET /api/config` response (`authMode` field) and conditionally shows the login page.

## User Identity

### users Table

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- UUID (app's stable identifier)
  os_uid INTEGER,                -- OS UID (nullable for future non-OS auth)
  username TEXT NOT NULL,         -- Current OS username
  home_dir TEXT NOT NULL,         -- Home directory path
  created_at TEXT NOT NULL,       -- ISO 8601
  updated_at TEXT NOT NULL        -- ISO 8601
);
CREATE UNIQUE INDEX idx_users_os_uid ON users(os_uid) WHERE os_uid IS NOT NULL;
```

- **`id` (UUID)**: App's own stable primary key. Used as `sessions.created_by` foreign key. Survives OS username changes.
- **`os_uid`**: OS numeric user ID. Stable across username changes. Used to find existing user records on login. Nullable to support future non-OS authentication methods (OAuth, etc.).
- **`username` / `home_dir`**: Cached from OS. Updated on each login (upsert by `os_uid`).

### AuthUser

```typescript
interface AuthUser {
  id: string;         // users.id (UUID)
  username: string;   // Current OS username
  homeDir: string;    // Home directory
}
```

`AuthUser` is returned by `UserMode.authenticate()` and `UserMode.login()`. It always includes `id` so callers can use it as a stable reference (e.g., `sessions.created_by`).

### User Record Lifecycle

- **`none` mode**: `SingleUserMode` creates a user record for the server process user on initialization (upsert by `os_uid`). `authenticate()` always returns this cached user.
- **`multi-user` mode**: `MultiUserMode.login()` creates or updates a user record on successful OS credential validation (upsert by `os_uid`). `authenticate()` decodes JWT which contains `users.id`.

## Shared Resources

### Repositories

Repositories and all their associated settings are **global resources shared across all users**:

- **Repository registration**: Both the server operator and users can register repositories.
- **Repository settings**: `env_vars`, `setup_command`, `cleanup_command`, `default_agent_id`, `description` — all shared. The server operator sets up the repository configuration once, and all users can use it immediately.
- **Worktrees**: Created per-session, so each user works in their own worktree of a shared repository.

This means a new user can log in and start working with pre-configured repositories without any setup.

### Future: Per-User env_vars Override

In a future version, `env_vars` will support per-user overrides. This will allow users to customize environment variables (e.g., personal API keys) while inheriting the shared base configuration. The override mechanism is out of scope for the initial implementation.

## PTY Spawning

### Single-User Mode (SingleUserMode)

Current behavior. The PTY process inherits the server user's identity:

```
sh -c '<unset-prefix> <command>'
```

Environment variables (repository env_vars, AGENT_CONSOLE_* vars) are passed via the process `env` option, merged into the parent process environment.

### Multi-User Mode (MultiUserMode)

PTY processes are spawned as the authenticated OS user via `sudo -u`:

```
sudo -u <loginuser> -i sh -c 'cd /path/to/worktree && export KEY1=val1 KEY2=val2; <command>'
```

Key differences from SingleUserMode:
- **`sudo -u <user> -i`** creates a full login shell as the target user, loading `.profile`/`.bashrc`/`.zshrc`
- **`cd` is required** — `-i` changes the working directory to the target user's HOME, so an explicit `cd` to the worktree path is needed
- **`<unset-prefix>` is not needed** — the login shell starts with a clean environment, so server env vars are not inherited
- **Environment variables are embedded in the command** — since `sudo -i` does not inherit the parent's process environment, repository env_vars and `AGENT_CONSOLE_*` variables are passed as `export` statements within the shell command
- The `UserMode` interface encapsulates these differences, so `WorkerManager` is unaware of the spawning mechanism

**Sudo skip optimization**: When the authenticated user is the same as the server process user (e.g., the server operator logs in as themselves), `MultiUserMode` skips `sudo` and falls back to direct spawning. This avoids unnecessary privilege escalation and removes the requirement for the service user to `sudo` to itself. This is an internal optimization within `MultiUserMode` — the `UserMode` interface is unaffected.

Since the process runs as the actual OS user:
- `HOME`, `USER`, `SHELL` are set correctly by the OS
- File permissions work naturally
- SSH keys (`~/.ssh/`) are accessible
- API keys in `~/.config/` or shell profile are loaded
- Git credential helpers (OS Keychain) work
- Chrome MCP and other local tools work

**Note**: In multi-user mode, the service account (`agentconsole`) is not intended to be used as a regular user. It exists solely to run the server process. All users, including the server operator, should log in with their own OS accounts.

## Deployment Prerequisites (Multi-User Mode Only)

The following setup is only required when running with `AUTH_MODE=multi-user`. In `none` mode (default), no additional setup is needed.

### Service User Setup

```bash
# 1. Create dedicated service user
sudo useradd -r -m agentconsole   # Linux
# or on macOS:
sudo dscl . -create /Users/agentconsole
sudo dscl . -create /Users/agentconsole UserShell /bin/zsh
sudo dscl . -create /Users/agentconsole NFSHomeDirectory /var/agentconsole

# 2. Configure sudoers (allow PTY spawning as any user)
# /etc/sudoers.d/agentconsole
agentconsole ALL=(ALL) NOPASSWD: /bin/sh, /bin/bash, /bin/zsh
```

This gives the service user the minimum privilege needed: the ability to start a shell as another user. The server itself runs as a regular user with no elevated privileges.

## Implementation Phases

### Phase 1: Shared Types & Schemas

**Modify:**
- `packages/shared/src/types/auth.ts` — Add `id: string` to `AuthUser` (UUID from users table)
- `packages/shared/src/types/session.ts:44` — Add `createdBy?: string` to `SessionBase` (references `users.id`)

**New files:**
- `packages/shared/src/schemas/auth.ts` — `LoginRequestSchema` (Valibot: username + password)

**Modify:**
- `packages/shared/src/index.ts` — Export new auth schemas

### Phase 2: Database Migration (v14)

**Modify:**
- `packages/server/src/database/schema.ts` — Add `UsersTable` interface and `created_by: string | null` to `SessionsTable`
- `packages/server/src/database/connection.ts` — Migration v14:
  - `CREATE TABLE users (id TEXT PRIMARY KEY, os_uid INTEGER, username TEXT NOT NULL, home_dir TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
  - `CREATE UNIQUE INDEX idx_users_os_uid ON users(os_uid) WHERE os_uid IS NOT NULL`
  - `ALTER TABLE sessions ADD COLUMN created_by TEXT REFERENCES users(id)`

### Phase 3: UserMode (Backend)

**New files:**
- `packages/server/src/services/user-mode.ts` — `UserMode` interface + `SingleUserMode` + `MultiUserMode`

#### UserMode Interface

```typescript
interface UserMode {
  authenticate(resolveToken: () => string | undefined): AuthUser | null;
  login(username: string, password: string): Promise<LoginResult | null>;
  spawnPty(request: PtySpawnRequest): PtyInstance;
}

interface AuthUser {
  id: string;         // UUID from users table
  username: string;
  homeDir: string;
}

interface LoginResult {
  user: AuthUser;
  token: string;  // Opaque cookie value
}
```

#### PtySpawnRequest (Discriminated Union)

```typescript
interface PtySpawnRequestBase {
  username: string;
  cwd: string;
  additionalEnvVars: Record<string, string>;  // Repository + template env vars
  cols: number;
  rows: number;
}

interface AgentPtySpawnRequest extends PtySpawnRequestBase {
  type: 'agent';
  command: string;
  agentConsoleContext: AgentConsoleContext;
}

interface TerminalPtySpawnRequest extends PtySpawnRequestBase {
  type: 'terminal';
}

type PtySpawnRequest = AgentPtySpawnRequest | TerminalPtySpawnRequest;

interface AgentConsoleContext {
  baseUrl: string;
  sessionId: string;
  workerId: string;
  repositoryId?: string;
  parentSessionId?: string;
  parentWorkerId?: string;
}
```

- **Agent worker**: `command` and `agentConsoleContext` are required — missing fields are compile errors
- **Terminal worker**: Neither `command` nor `agentConsoleContext` can be provided — the shell command (`exec $SHELL -l`) is constructed internally by UserMode, which ensures the correct user's shell is used in both modes

#### SingleUserMode (Null Object for `none` mode)

Constructor receives `PtyProvider` and `UserRepository` (injected at startup). On initialization, upserts a user record for the server process user (by `os_uid`) and caches the resulting `AuthUser`.

- `authenticate()` — Always returns the cached server process user (ignores token)
- `login()` — Always returns the cached server process user (no credential validation)
- `spawnPty()` — Direct spawn: `sh -c '<unset-prefix> <command>'` with env vars passed via process `env` option. Internally calls `getCleanChildProcessEnv()` for base environment and `getUnsetEnvPrefix()` for command prefix.

#### MultiUserMode (`multi-user` mode)

Constructor receives `PtyProvider` (injected at startup). Requires async initialization to load or generate JWT secret from `${AGENT_CONSOLE_HOME}/jwt-secret`.

- `authenticate()` — Calls `resolveToken()` to get JWT, validates it, returns `AuthUser` from token payload. Returns `null` if invalid.
- `login()` — Validates OS credentials (macOS: `dscl . -authonly`, Linux: PAM), looks up home directory, generates JWT. Returns `LoginResult` or `null`. Home directory lookup is an internal implementation detail (not exposed on the interface).
- `spawnPty()` — Spawns via `sudo -u <user> -i sh -c 'cd <cwd> && export ...; <command>'` with env vars embedded in the command string. No base environment needed (login shell loads user's profile). **Sudo skip optimization**: when username matches server process user, falls back to direct spawn.
- JWT secret: `crypto.randomBytes(32)`, stored at `${AGENT_CONSOLE_HOME}/jwt-secret` (persists across restarts)
- Token payload: `{ sub: username, home: homeDir, iat, exp }`, expires 7 days

### Phase 4: AppContext Integration

**Modify:**
- `packages/server/src/lib/server-config.ts` — Add `AUTH_MODE` (`'none' | 'multi-user'`, default `'none'`)
- `packages/server/src/app-context.ts:46` — Add `userMode: UserMode` to `AppContext` interface
- `packages/server/src/app-context.ts:104` — In `createAppContext()`, select implementation based on `AUTH_MODE`:
  - `none` → `await SingleUserMode.create(bunPtyProvider, userRepository)`
  - `multi-user` → `await MultiUserMode.create(bunPtyProvider, userRepository)` (async: loads JWT secret)
- `packages/server/src/app-context.ts:191` — Add `userMode?: UserMode` to `CreateTestContextOptions` for test injection (tests pass `new SingleUserMode(mockPtyProvider)`)

### Phase 5: Auth Middleware & Routes (Backend)

**New files:**
- `packages/server/src/middleware/auth.ts` — Hono middleware: calls `userMode.authenticate(() => getCookie(c, 'auth_token'))` → set `authUser` on context. In `none` mode, `SingleUserMode` always returns the server process user, so all requests pass. In `multi-user` mode, `MultiUserMode` validates the JWT and returns 401 if `null`.
- `packages/server/src/routes/auth.ts` — Auth endpoints:
  - `POST /api/auth/login` — Call `userMode.login(username, password)`, set cookie from `LoginResult.token`, return `AuthUser`
  - `POST /api/auth/logout` — Clear cookie
  - `GET /api/auth/me` — Return current user via `userMode.authenticate(resolveToken)` (no 401, returns `null` if unauthenticated). In `none` mode, returns the server process user.

**Modify:**
- `packages/server/src/routes/api.ts` — Mount auth routes BEFORE auth middleware. Auth middleware runs on all `/api/*` routes in both modes (`SingleUserMode` handles `none` mode transparently).
- `packages/server/src/routes/api.ts:22` — `GET /config` returns `authMode` field and `authUser.homeDir`

### Phase 6: Session Ownership (Backend)

**New files:**
- `packages/server/src/repositories/user-repository.ts` — `UserRepository` interface
- `packages/server/src/repositories/sqlite-user-repository.ts` — SQLite implementation with `upsertByOsUid()` and `findById()`

**Modify:**
- `packages/server/src/services/internal-types.ts` — Add `createdBy?: string` to `InternalSessionBase` (references `users.id`)
- `packages/server/src/services/persistence-service.ts` — Add `createdBy?: string` to `PersistedSessionBase`
- `packages/server/src/database/mappers.ts` — Map `created_by` ↔ `createdBy`
- `packages/server/src/repositories/sqlite-session-repository.ts` — Include `created_by` in save (not in update — immutable after creation)
- `packages/server/src/services/session-manager.ts:511` — `createSession()` accepts `createdBy` param (users.id), stores it
- `packages/server/src/services/session-manager.ts` — `toPublicSession()` includes `createdBy`
- `packages/server/src/routes/sessions.ts:60` — Extract `authUser.id` from context (always present due to Null Object pattern), pass to `createSession()`

### Phase 7: MCP User Propagation

**Modify:**
- `packages/server/src/mcp/mcp-server.ts` — `delegate_to_worktree`: inherit `createdBy` from parent session
- `packages/server/src/mcp/mcp-server.ts` — `send_session_message`: no auth change needed (operates within server)

### Phase 8: Per-User PTY Spawning

**Modify:**
- `packages/server/src/services/worker-manager.ts` — Use `userMode.spawnPty(request)` (injected via AppContext) instead of calling `ptyProvider.spawn()` directly:
  - WorkerManager constructs `AgentPtySpawnRequest` or `TerminalPtySpawnRequest` with `additionalEnvVars` (repository + template + agentConsole context) and calls `userMode.spawnPty()`
  - `username` for PTY spawning is resolved from the session's `createdBy` (users.id → users.username). For backwards compatibility, if `createdBy` is null (pre-multi-user sessions), the server process username is used — this results in direct spawning (no sudo) regardless of mode.
  - WorkerManager no longer calls `getCleanChildProcessEnv()` or `getUnsetEnvPrefix()` — base environment construction is an internal concern of each UserMode implementation
  - WorkerManager no longer holds `PtyProvider` — it is owned by UserMode
  - WorkerManager does not check AUTH_MODE — it delegates to UserMode
- `packages/server/src/services/env-filter.ts` — No interface changes needed. `getCleanChildProcessEnv()` and `getUnsetEnvPrefix()` are used internally by `SingleUserMode`.

### Phase 9: WebSocket Authentication

**Modify:**
- `packages/server/src/websocket/routes.ts:444` — In `/ws/app` onOpen: call `userMode.authenticate(resolveToken)` with cookie. In `none` mode, `SingleUserMode` always passes. In `multi-user` mode, `null` result causes connection close with `POLICY_VIOLATION`.
- `packages/server/src/websocket/routes.ts:512` — In `/ws/session/:id/worker/:id` onOpen: same pattern.

Note: Browser automatically sends cookies with WebSocket upgrade requests (same-origin), so no client-side changes needed for WebSocket auth.

### Phase 10: Client Auth Flow

**New files:**
- `packages/client/src/routes/login.tsx` — Login page (username + password form)
- `packages/client/src/lib/auth.ts` — Auth state management (React context + TanStack Query)
- `packages/client/src/contexts/AuthContext.tsx` — `AuthProvider` wrapping app, provides `authUser`

**Modify:**
- `packages/client/src/routes/__root.tsx` — On mount, fetch `GET /api/config` to get `authMode`. If `multi-user`, check auth state via `GET /api/auth/me` and redirect to `/login` if unauthenticated. If `none`, skip login and proceed directly.
- `packages/client/src/lib/api.ts` — Add `login()`, `logout()`, `fetchCurrentUser()` functions
- `packages/client/src/lib/path.ts` — `setHomeDir()` already exists, will receive per-user home from `/api/config`

### Phase 11: Client Session Filtering

**New files:**
- `packages/client/src/hooks/useSessionFilter.ts` — Filter hook: `all` | `mine` | specific username. Persisted to localStorage.

**Modify:**
- Session list UI (sidebar/dashboard) — Add filter dropdown. Show `createdBy` on session cards.

## Verification

1. **Login flow**: Access app with `AUTH_MODE=multi-user` → redirected to login → enter OS username + password → logged in → see dashboard
2. **Session ownership**: Create session → verify `createdBy` shows current username in UI and API response
3. **Home directory**: After login, check `GET /api/config` returns authenticated user's home. Verify `~` in path display resolves correctly.
4. **PTY identity**: Create terminal worker → run `whoami && echo $HOME && echo $SSH_AUTH_SOCK` → verify all match the logged-in user
5. **File permissions**: Create a file in terminal → verify owner is the logged-in user, not the service user
6. **Session filtering**: Create sessions as different users → filter toggle works → "My sessions" shows only own sessions
7. **MCP delegation**: `delegate_to_worktree` → child session inherits parent's `createdBy`
8. **WebSocket auth**: In `multi-user` mode, open WebSocket without auth cookie → connection rejected
9. **Backwards compat**: Existing sessions (no `createdBy`) display without errors, appear under "All users" filter. PTY spawns directly (no sudo) for sessions without `createdBy`.
10. **Mode switching**: Start with `AUTH_MODE=none` → no login page, current behavior preserved. Start with `AUTH_MODE=multi-user` → login required.
11. **Shared repositories**: In multi-user mode, repository registered by server operator is visible and usable by all users immediately.
12. **Run existing tests**: `bun test` passes (with `AUTH_MODE=none`)
