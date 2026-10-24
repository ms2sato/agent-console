# Agent Console

> **Note**: Developed and tested on macOS with Claude Code. The multi-user server mode is also verified on Linux (Ubuntu, systemd): CI runs a Docker verification of multi-user mode and a systemd-based stack on GitHub-hosted Linux runners, and the project's own deployment runs on Ubuntu 24.04. Other distributions are not verified. See [Multi-user Mode](#multi-user-mode).

> **Security Note**: Agent Console is designed for local use by an individual or a team on a trusted network. It provides terminal access to the host and must not be exposed to the public internet or untrusted networks, in single-user and multi-user mode alike. The server binds to `localhost` by default.

A web application for managing multiple AI coding agent instances running in different git worktrees. Control all your agents through a unified browser interface instead of scattered terminal windows.

**[Claude Code](https://claude.ai/code)** is the built-in agent. Other terminal-based agents can be registered as custom agents on the Agents page, and an experimental *embedded agent* (an agent loop that runs inside Agent Console instead of in a terminal, still in development) is available as an option alongside the terminal model.

## Features

- **Unified Dashboard**: View and manage all repositories, worktrees, and agent sessions in one place
- **Browser-based Terminal**: Full terminal access via [xterm.js](https://xtermjs.org) - no need for separate terminal windows
- **Session Persistence**: Sessions continue running even when you close the browser tab (tmux-like behavior)
- **Multiple Workers per Session**: Run agent, terminal, git-diff, file-viewer and (experimental) embedded-agent workers side-by-side within a single session
- **Inter-worker Messaging**: Send messages between workers in the same session via an embedded message panel
- **Git Worktree Integration**: Create and delete git worktrees directly from the UI; add a repository by cloning from a URL (optionally as a bare repository) or by registering an existing path
- **Diff Review with Annotations**: A git-diff worker shows a worktree's changes; agents can push review annotations that appear in the diff in real time, and the Review page lists pending reviews
- **File Viewer**: Add a File viewer tab from the `+` menu to browse the session's working directory read-only: a lazily expanded file tree (dotfiles and `.git` included, nothing filtered) beside the selected file with line numbers and syntax highlighting; large files are cut at 1 MiB, binary files show only their size, and on a phone the tree opens as a drawer. The viewer follows file changes live (a file the agent edits or creates updates without pressing Refresh); where the server cannot watch a directory it says so and Refresh still works
- **Session Memo**: Agents write Markdown memos for a session; fenced code blocks have a one-click Copy control, and the memo's command blocks can be run in the session's terminal after a confirmation
- **Human Todo List**: A Todo page, a per-item detail page (`/todos/:id`) and a per-session panel where agents leave questions and actions that need a human, and humans resolve, dismiss or reply on them (the agent answers on the same item), and move an item to another session
- **Bookmarks and HTML Artifacts**: Agents register URLs as session bookmarks and publish self-contained HTML pages that you open from the session sidebar or the Artifacts page
- **Timers and Conditional Wakeups**: Periodic timers (with optional exponential backoff) and silent polling wakeups that notify an agent only when a shell condition becomes true; both pause with their session, and notifications (including inbound GitHub webhook events) that arrive while a session is paused are delivered to its workers as one digest on resume
- **Notifications and Integrations**: A notification center, per-repository Slack notifications, and inbound GitHub webhook events (see [GitHub Webhook Integration](#github-webhook-integration-inbound-events))
- **Custom Agents and Jobs**: Manage agent definitions on the Agents page and watch background jobs on the Jobs page, both reached from the header's user menu
- **Multi-user Mode**: One server shared by several OS users on the same machine, each running as their own user, with optional shared accounts (see [Multi-user Mode](#multi-user-mode))
- **Real-time Updates**: WebSocket-based notifications for session and worker lifecycle changes
- **Orchestration via MCP**: Agents can delegate tasks, coordinate workflows, and manage other agents programmatically via [MCP](https://modelcontextprotocol.io) tools

## Key Concepts

- **Session**: A working context tied to a git worktree or arbitrary directory. Each session can have multiple workers.
- **Worker**: A process or view running within a session. Types:
  - **Agent Worker**: Runs an AI agent (e.g., Claude Code) in a PTY
  - **Terminal Worker**: A plain terminal shell
  - **Git-diff Worker**: A diff view of the worktree's changes, with review annotations
  - **File-viewer Worker**: A read-only file tree and file view of the session's working directory
  - **Embedded-agent Worker** (experimental): An agent loop owned by Agent Console itself rather than a terminal program; see [docs/design/embedded-agent-worker.md](docs/design/embedded-agent-worker.md)
- **Agent**: The definition of an AI tool (command, activity patterns, etc.). Claude Code is built in; custom agents can be registered.

## Architecture

```
Backend (Bun + Hono)                Frontend (React + Vite)
┌──────────────────────────┐        ┌──────────────────────────┐
│ SessionManager           │        │ Dashboard                │
│ ├── Session1             │        │ ├── SessionList          │
│ │   ├── AgentWorker     │◄──────►│ │   └── WorkerTabs       │
│ │   └── TerminalWorker   │  WS   │ └── Terminal (xterm.js)  │
│ └── Session2             │        │                          │
│     └── AgentWorker      │        │                          │
└──────────────────────────┘        └──────────────────────────┘
```

The diagram shows the two terminal-based worker types; git-diff and embedded-agent workers live in the same session model and use the same WebSocket and state-sync layer. The server is the source of truth for session and worker state.

## Requirements

- [Bun](https://bun.sh) >= 1.3.5

  `scripts/check-bun-version.mjs` is wired as a `preinstall` hook and hard-fails on older Bun, so the requirement is enforced rather than advisory. The floor is set by two features: `Bun.Terminal` (used by the server, 1.3.5+) and `minimumReleaseAge` (the supply-chain age gate, 1.3.0+); the higher of the two wins. See [Supply Chain Security](#supply-chain-security) for the age gate details.

## Development

### Setup

```bash
# Install dependencies
bun install

# Start development servers (frontend + backend)
bun dev
```

The development server runs at:
- Frontend: http://localhost:5173
- Backend: http://localhost:3457

### Environment Configuration

When running multiple development instances (e.g., in different git worktrees), you can use a `.env` file to avoid port and data conflicts.

```bash
# Copy the example file
cp .env.example .env

# Edit .env with your settings
```

Available variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3457` | Backend server port |
| `CLIENT_PORT` | `5173` | Frontend dev server port |
| `AGENT_CONSOLE_HOME` | `~/.agent-console-dev` | Data directory (DB, outputs) |

Bun automatically loads `.env` files - no additional packages required.

For a `claude-sdk` embedded worker's project `.mcp.json` `${VAR}` placeholders: in single-user mode the placeholders resolve from the server's cleaned environment (see [`docs/multi-user-setup-guide.md`](docs/multi-user-setup-guide.md#step-5-user-account-requirements) for the multi-user equivalent).

### Build

```bash
bun run build
```

This creates a production bundle in the `dist/` directory:

```
dist/
├── package.json    # Standalone package manifest
├── index.js        # Bundled server
└── public/         # Built frontend assets
```

### Production

```bash
# From the project root (after build)
bun start
```

Or run directly:

```bash
NODE_ENV=production bun dist/index.js
```

The server runs at http://localhost:3457

### macOS Launch Agent

A deployment script is provided to install Agent Console as a macOS Launch Agent (auto-start on login):

```bash
# Deploy with defaults (port 6340)
./scripts/update-and-deploy-for-mac.sh

# Deploy with custom port
PORT=8080 APP_URL=http://localhost:8080 ./scripts/update-and-deploy-for-mac.sh
```

The script builds the project, copies files to `~/.agent-console/server/`, installs a launchd plist, and starts the service.

#### Environment Configuration via `~/.agent-console/.env`

The Launch Agent loads `~/.agent-console/.env` on every startup. This is the recommended way to configure the server in production — especially for secrets that should not be embedded in the plist file.

```bash
# Example: ~/.agent-console/.env
GITHUB_WEBHOOK_SECRET=your-secret-here
LOG_LEVEL=info
```

After editing `.env`, restart the service to apply changes (no redeployment required):

```bash
launchctl kickstart -k "gui/$(id -u)/com.agent-console"
```

Available server environment variables are defined in [`packages/server/src/lib/server-config.ts`](packages/server/src/lib/server-config.ts).

> **Note**: Variables set in `.env` override values from the launchd plist. `PORT`, `APP_URL`, `NODE_ENV`, and `PATH` are set in the plist at deploy time; all other variables should be configured via `.env`.

## Supply Chain Security

This repo uses Bun's [`minimumReleaseAge`](https://bun.com/docs/runtime/bunfig#install-minimumReleaseAge) install setting to refuse npm package versions younger than 7 days. Compromised packages are usually detected or unpublished within a few days of release, so a short cool-off window catches the common case while letting routine updates through.

Configuration lives in [`bunfig.toml`](./bunfig.toml) at the repo root. A `preinstall` hook ([`scripts/check-bun-version.mjs`](./scripts/check-bun-version.mjs)) enforces the repo's minimum Bun version, which is at or above the 1.3.0 floor required by `minimumReleaseAge`, so the age gate is never silently ignored.

### Emergency override

When you genuinely need a just-published version (e.g., a CVE patch), bypass the gate for that single command rather than editing `bunfig.toml`:

```bash
# CLI flag, scoped to one invocation:
bun add <pkg> --minimum-release-age 0

# Or via environment variable:
BUN_CONFIG_MINIMUM_RELEASE_AGE=0 bun install
```

Record the reason (CVE number, advisory link, etc.) in the commit message or PR description so the override is auditable. Do **not** lower `minimumReleaseAge` in `bunfig.toml` — keep the gate intact and override per-command.

## Standalone Distribution

The `dist/` directory can be distributed independently. Users only need to:

```bash
cd dist
bun install   # Installs only bun-pty (~few seconds)
bun start     # Starts the server
```

## Template Configuration

When creating a new worktree, Agent Console can automatically copy template files into it. This is useful for setting up consistent configurations (e.g., `.claude/settings.local.json` for MCP servers) across all worktrees.

### Template Locations

Templates are searched in the following order (first found wins):

1. **Repository-local**: `.agent-console/` directory in the repository root
2. **Global**: `$AGENT_CONSOLE_HOME/repositories/<owner>/<repo>/templates/`

The default `$AGENT_CONSOLE_HOME` is `~/.agent-console`.

### Directory Structure

Place files in the templates directory with the same structure you want in the worktree:

```
~/.agent-console/repositories/<owner>/<repo>/templates/
├── .claude/
│   └── settings.local.json    # → copied to <worktree>/.claude/settings.local.json
├── .env.local                  # → copied to <worktree>/.env.local
└── any/
    └── nested/
        └── file.txt           # → copied to <worktree>/any/nested/file.txt
```

### Placeholders

Template files support variable substitution using `{{VARIABLE}}` syntax:

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{WORKTREE_NUM}}` | Worktree index number (0, 1, 2, ...) | `1` |
| `{{BRANCH}}` | Branch name | `feature/add-login` |
| `{{REPO}}` | Repository name (without owner) | `agent-console` |
| `{{WORKTREE_PATH}}` | Full path to the worktree | `/Users/me/.agent-console/.../wt-001-abc` |

### Arithmetic Expressions

`{{WORKTREE_NUM}}` supports arithmetic operations:

| Expression | Description | Example (WORKTREE_NUM=2) |
|------------|-------------|--------------------------|
| `{{WORKTREE_NUM + 3000}}` | Addition | `3002` |
| `{{WORKTREE_NUM - 1}}` | Subtraction | `1` |
| `{{WORKTREE_NUM * 10}}` | Multiplication | `20` |
| `{{WORKTREE_NUM / 2}}` | Division (floor) | `1` |

### Example: Environment Variables

To configure different ports for each worktree's development server (`.env.local`):

```bash
# Worktree: {{BRANCH}}
DEV_PORT={{WORKTREE_NUM + 3000}}
API_PORT={{WORKTREE_NUM + 4000}}
```

With this template, worktree 0 uses DEV_PORT=3000, worktree 1 uses DEV_PORT=3001, and so on.

## Orchestration via MCP

Agent Console exposes [MCP (Model Context Protocol)](https://modelcontextprotocol.io) tools that turn any AI agent into an **orchestrator**. A single agent can delegate tasks to new worktrees, monitor their progress, coordinate inter-agent communication, run review workflows, and manage timers — all programmatically through a unified tool interface.

### Setup

Register the Agent Console MCP server in Claude Code (one-time):

```bash
# For production (default port 6340) for user scope
claude mcp add --scope user --transport http agent-console http://localhost:6340/mcp

# For production (default port 6340) for local scope
claude mcp add --transport http agent-console http://localhost:6340/mcp

# For development (if using a different port, match your .env PORT) for local scope
claude mcp add --transport http agent-console-dev http://localhost:3457/mcp
```

This adds the MCP server to `~/.claude.json`. All Claude Code instances (including those spawned by Agent Console) will automatically discover the tools.

> **Tip**: If you change the server port, update the URL accordingly. Multiple Agent Console instances can coexist with different names (e.g., `agent-console`, `agent-console-2`).

### Available MCP Tools

#### Session Management

| Tool | Description |
|------|-------------|
| `list_sessions` | List all active sessions with worker activity states |
| `get_session_status` | Get a specific session's status, workers, and parent info |
| `close_session` | Close a session and clean up its workers |
| `restart_all_agents` | Restart all workers with a live process across the sessions you may operate (PTY agent workers and active embedded-agent workers) |

#### Worktree Delegation

| Tool | Description |
|------|-------------|
| `delegate_to_worktree` | Create a worktree + session + agent and send a prompt — the primary orchestration tool |
| `remove_worktree` | Remove a git worktree and its associated session |

#### Communication

| Tool | Description |
|------|-------------|
| `send_session_message` | Send a message to a worker in another session (file-based with PTY notification) |
| `write_memo` | Write a Markdown memo for a session, visible in the UI |
| `create_todo` | Add an item to the human Todo list: a question that needs a human answer, or an action a human has to carry out |
| `list_todos` | List this session's Todo items, newest first (to catch up on what humans resolved or dismissed) |
| `resolve_todo` | Mark items of this session done on the strength of a human's words (the human's statement quoted), for example when the human answered in chat; several items can be resolved in one call |
| `adopt_todo` | Take over an open Todo item of another session (a successor session after a handoff): the item moves to this session and worker, so the human's resolution reaches the live session; `list_todos` with `global: true` lists the other sessions' global items; taking over an item of a session owned by another user needs the human's quoted words as `statement` |
| `comment_todo` | Reply on an open or done Todo item of this session (the human reads the reply in the item's thread; the item stays as it is) |

#### Timer and Wakeup

| Tool | Description |
|------|-------------|
| `create_timer` | Create a periodic timer that sends notifications to a worker at specified intervals |
| `delete_timer` | Delete a periodic timer |
| `reset_timer` | Reset a timer to its base interval (restarts exponential backoff) |
| `list_timers` | List active timers, optionally filtered by session |
| `create_conditional_wakeup` | Check a shell command at intervals and notify only when the condition becomes true (exit 0) or a timeout is reached |
| `delete_conditional_wakeup` | Delete a conditional wakeup; the condition checking stops immediately |

#### Interactive Process

| Tool | Description |
|------|-------------|
| `run_process` | Start an interactive script that communicates via STDOUT/STDIN. A process that finishes within 5 seconds returns its output and exit code in the result and sends no further turn; a longer one reports back as new turns |
| `write_process_response` | Send a response to a waiting interactive process |
| `kill_process` | Terminate a running interactive process |
| `list_processes` | List all interactive processes (useful after agent restart) |

#### Review

| Tool | Description |
|------|-------------|
| `write_review_annotations` | Write review annotations for a git-diff worker, pushed to the client in real-time |
| `clear_review_annotations` | Clear all review annotations for a git-diff worker |

#### Bookmarks and HTML Artifacts

| Tool | Description |
|------|-------------|
| `create_bookmark` | Register an http(s) URL (with an optional title) as a bookmark in the session sidebar |
| `delete_bookmark` | Permanently delete a bookmark |
| `create_html_artifact` | Upload an HTML document (optionally with inline JavaScript/CSS) and receive a URL to view it in a browser; stored per user until deleted |
| `update_html_artifact` | Replace the content of an artifact in place (same id and URL); only the owner may update it |
| `delete_html_artifact` | Permanently delete an artifact; any URL already shared for it stops working |

#### Agent & Repository Registry

| Tool | Description |
|------|-------------|
| `list_agents` | Discover available agents (built-in + custom) with capabilities |
| `list_repositories` | Discover available repositories with IDs and remote URLs |
| `update_repository` | Update a registered repository's setup command, cleanup command, environment variables, description, or default agent |

#### Orchestrator Designation

| Tool | Description |
|------|-------------|
| `set_orchestrator_session` | Add this session to its repository's designated-Orchestrator set, so webhook-triggered inbound events are delivered to it |
| `clear_orchestrator_session` | Remove this session from the designated-Orchestrator set (idempotent) |

#### Embedded Agents (experimental)

| Tool | Description |
|------|-------------|
| `set_agent_parameters` | Change your own embedded-agent worker's model, reasoning effort, or context window while it runs |
| `set_mcp_server_permission` | Decide whether a project-scope MCP server declared in a worktree's `.mcp.json` may start for an embedded-agent worker |

### Patterns in Practice

#### Parallel Delegation

An orchestrator splits work across multiple worktrees and monitors progress:

```
Orchestrator (wt-000)
    ├── delegate_to_worktree → Agent A (wt-001): "implement feature X"
    ├── delegate_to_worktree → Agent B (wt-002): "write tests for module Y"
    └── delegate_to_worktree → Agent C (wt-003): "fix bug Z"
    
    ... later ...
    ├── get_session_status(wt-001) → "active, working"
    ├── get_session_status(wt-002) → "idle, waiting for input"
    └── get_session_status(wt-003) → "idle, task complete"
```

With `parentSessionId` and `parentWorkerId`, delegated agents automatically report results back via `send_session_message`.

#### Timer-Based Monitoring

Set up periodic check-ins to monitor long-running tasks:

```
create_timer(sessionId, workerId, intervalSeconds: 300, action: "check CI status and report")
    → Timer fires every 5 minutes with [internal:timer] PTY notification
    → Agent wakes up, checks status, takes action
    
delete_timer(timerId)  # Clean up when done
```

#### Interactive Process Workflow

Drive scripts that require back-and-forth communication:

```
run_process(command: "node acceptance-check.js 526", sessionId, workerId)
    → Process starts, sends STDOUT as [internal:process] PTY notifications
    → Agent reads output, decides next action
    
write_process_response(processId, content: "approve")
    → Process receives response, continues execution
    
kill_process(processId)  # Terminate if needed
```

#### Review and Memo

Annotate diffs for human review and leave persistent notes:

```
write_review_annotations(workerId, sessionId, annotations: [...], summary: {...})
    → Annotations appear in the git-diff viewer in real-time

write_memo(sessionId, content: "## Status\n- Feature complete\n- Tests passing\n- Ready for review")
    → Memo visible in the session UI panel
```

See [docs/design/self-worktree-delegation.md](docs/design/self-worktree-delegation.md) for the full design document.

## Multi-user Mode

By default Agent Console runs in single-user mode (`AUTH_MODE=none`). In multi-user mode (`AUTH_MODE=multi-user`) one server, running as a dedicated service user, is shared by several OS users on the same machine: each user logs in through the browser with their own OS account, and their terminals, agents and git worktrees run as that user (file permissions, SSH keys and API keys work as usual). Repositories can be cloned once into a shared source directory and worktrees are created per user, and *shared accounts* let a team run a shared session as a common OS account bound to a repository.

Setup is documented in [docs/multi-user-setup-guide.md](docs/multi-user-setup-guide.md), with a bootstrap script for Linux (`scripts/setup-multiuser-for-ubuntu.sh`) and a deploy script (`scripts/update-and-deploy-for-multiuser-ubuntu.sh`). It is verified on Linux (Ubuntu, systemd): a Docker verification (`scripts/verify-multiuser-docker.sh`) and a systemd-as-PID-1 stack (`scripts/verify-multiuser-systemd.sh`) run in CI, and a macOS (launchd) recipe is in the guide. Multi-user mode is still meant for a trusted network, not the public internet.

## GitHub Webhook Integration (Inbound Events)

Agent Console can receive GitHub webhooks and route them to active sessions. When a webhook arrives (e.g., CI failure, PR merged), Agent Console:

- Matches the event to sessions working on the same repository
- Notifies agent workers by writing a structured message to the agent's PTY input
- Sends UI notifications via WebSocket to connected browsers

### Setup

1. **Set the webhook secret** environment variable:

   ```bash
   GITHUB_WEBHOOK_SECRET=your-secret-here
   ```

   For the macOS Launch Agent, add it to [`~/.agent-console/.env`](#environment-configuration-via-agent-consoleenv).

2. **Expose the webhook endpoint** to the internet:

   GitHub sends webhooks from its servers, so your local Agent Console must be reachable via a public URL. Use a tunnel service such as [ngrok](https://ngrok.com), [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), or similar:

   ```bash
   # Example with ngrok (forward to the Agent Console server port)
   ngrok http 3457
   # → https://xxxx-xxxx.ngrok-free.app
   ```

3. **Configure the webhook in GitHub**:

   - Go to **Settings > Webhooks > Add webhook** in your repository (or organization)
   - **Payload URL**: `https://<your-tunnel-domain>/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: Same value as `GITHUB_WEBHOOK_SECRET`
   - **Events**: Select individual events: `Workflow runs`, `Issues`, `Pull requests`

### Multi-user mode (Ubuntu / systemd) recipe

Place the secret in a file **outside the deploy target** so that the rsync `--delete` in `scripts/update-and-deploy-for-multiuser-ubuntu.sh` does not wipe it on the next redeploy. The recommended path is `/home/<service-user>/.config/agent-console/secrets.env`, owned by the service user with mode `0600`. Then point the systemd unit at it via `EnvironmentFile=-`.

```bash
# 1. Secret file outside the deploy target
sudo mkdir -p /home/agentconsole/.config/agent-console
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" | \
  sudo tee /home/agentconsole/.config/agent-console/secrets.env
sudo chown -R agentconsole:agentconsole /home/agentconsole/.config/agent-console
sudo chmod 600 /home/agentconsole/.config/agent-console/secrets.env

# 2. Reference from the systemd unit
sudo systemctl edit --full agent-console.service
# In [Service], add:
#   EnvironmentFile=-/home/agentconsole/.config/agent-console/secrets.env
# The leading `-` makes the unit start even if the file is absent.

# 3. Reload + restart
sudo systemctl daemon-reload
sudo systemctl restart agent-console.service

# 4. Verify (see "Verifying webhook configuration" below for the auth-cookie variant)
# From a logged-in browser DevTools console:
#   fetch('/api/system/health').then(r => r.json()).then(console.log)
# → { webhookSecretConfigured: true, ... }
```

**Why outside the deploy target.** `scripts/update-and-deploy-for-multiuser-ubuntu.sh` syncs the source-repo into the deploy target with `rsync -a --delete`, excluding only `node_modules` and `.git`. A secret file placed at `<deploy-target>/.env` would work on the first deploy (Bun auto-loads env files at `WorkingDirectory`) but would be deleted on the next `update-and-deploy-for-multiuser-ubuntu.sh` invocation, because env files are excluded from the source-repo by `.gitignore`. Placing the secret under `/home/<service-user>/.config/agent-console/` and referencing it via `EnvironmentFile=-` keeps deploys and secret management on independent lifecycles.

**Tunneling for inbound webhooks** (Cloudflare Tunnel, ngrok, etc.) works the same as in the single-user instructions above — point the public URL at the server's `HOST:PORT` (e.g. `127.0.0.1:8080` for the bootstrap default).

### Supported Events

| GitHub Event | Condition | Inbound Event | Actions |
|---|---|---|---|
| Workflow runs | Completed successfully | `ci:completed` | Notify agent, refresh diff view |
| Workflow runs | Completed with failure | `ci:failed` | Notify agent, show UI alert |
| Issues | Closed | `issue:closed` | Show UI alert |
| Pull requests | Merged | `pr:merged` | Refresh diff view, show UI alert |

### How Events Are Routed

- Events are matched to sessions by comparing the webhook's repository name with each session's git remote URL
- If the event includes a branch name, only sessions working on that branch are notified
- Events without a branch (e.g., issue closed) are delivered to all sessions for that repository

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Yes | (empty) | Shared secret for HMAC-SHA256 signature verification. If unset, incoming webhooks are accepted but not processed (the endpoint still returns 200 OK). Check server logs or `GET /api/system/health` to verify configuration. |

### Verifying webhook configuration via `/api/system/health`

`GET /api/system/health` returns `{ webhookSecretConfigured: boolean, appUrl: string | null }` for the running server. **This endpoint requires authentication** — unauthenticated requests return `401 Unauthorized`. Two reliable ways to call it:

- **From a logged-in browser DevTools console:**
  ```js
  fetch('/api/system/health').then(r => r.json()).then(console.log)
  ```
- **With curl, providing the auth cookie:** Copy the `auth_token=...` cookie value from your browser's DevTools (Application → Cookies) and pass it via `--cookie`. The cookie name is `auth_token` (defined in `packages/server/src/lib/auth-constants.ts`):
  ```bash
  curl -s --cookie "auth_token=<your-auth-cookie-value>" http://localhost:8080/api/system/health | jq
  ```

A simple unauthenticated `curl -sf http://localhost:8080/api/system/health` returns an empty body (silent failure on 401), which is easy to misread as "the webhook is unconfigured." Use one of the authenticated paths above.

## Project Structure

```
agent-console/
├── packages/
│   ├── client/          # React frontend
│   ├── server/          # Hono backend
│   └── shared/          # Shared TypeScript types
├── docs/                # Documentation
├── scripts/             # Deployment scripts
└── dist/                # Production build output (generated)
```

## Contributing

See `AGENTS.md` for repository guidelines, commands, and testing expectations.

## Tech Stack

- **Backend**: [Bun](https://bun.sh), [TypeScript](https://www.typescriptlang.org), [Hono](https://hono.dev), [bun-pty](https://github.com/sursaone/bun-pty)
- **Frontend**: [React](https://react.dev), [TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev), [TanStack Router](https://tanstack.com/router), [TanStack Query](https://tanstack.com/query), [xterm.js](https://xtermjs.org), [Tailwind CSS](https://tailwindcss.com)
- **Build**: [Bun bundler](https://bun.sh/docs/bundler) (server), [Vite](https://vite.dev) (frontend)
- **Package Manager**: [Bun workspaces](https://bun.sh/docs/install/workspaces)

## AI-Driven Development

This project serves as a testbed for exploring the boundaries of AI-assisted software development. The goal is to minimize human involvement throughout the entire development lifecycle:

- **Code generation**: All code is written by Claude Code, not by humans
- **Code review**: Reviews are performed by Claude subagents (code-quality-reviewer, test-reviewer, ux-architecture-reviewer)
- **Testing**: Test code is also generated and reviewed by AI

The human role is limited to:
- Providing high-level requirements and direction
- Final approval of pull requests
- Resolving issues that AI cannot handle autonomously

This approach allows us to dogfood Agent Console while simultaneously validating how far AI can go in autonomous software development. The codebase you see here is the result of this experiment.

## Special Thanks

This project is built on the shoulders of amazing open-source projects:

- [Claude Code](https://claude.ai/code) - The AI coding agent that wrote most of this codebase with remarkable speed and quality. This project literally couldn't exist without it.
- [Bun](https://bun.sh) - Blazing fast runtime that makes development a joy
- [Hono](https://hono.dev) - Ultrafast web framework with excellent DX
- [TypeScript](https://www.typescriptlang.org) - Type safety that saves countless debugging hours
- [xterm.js](https://xtermjs.org) - The terminal emulator that makes browser-based CLI possible

### Inspiration

- [Vibe Kanban](https://www.vibekanban.com/) - A fantastic project for managing AI coding agents. Exploring this project sparked the idea for Agent Console. Highly recommended!

Thank you to all the maintainers and contributors!

## License

MIT
