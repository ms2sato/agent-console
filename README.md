# Agent Console

> **Note**: Currently only tested on macOS & Claude Code.

A web application for managing multiple AI coding agent instances running in different git worktrees. Control all your agents through a unified browser interface instead of scattered terminal windows.

Currently supports **[Claude Code](https://claude.ai/code)** as the default agent, with plans to support additional agents (Gemini CLI, Codex, etc.) in the future.

## Features

- **Unified Dashboard**: View and manage all repositories, worktrees, and agent sessions in one place
- **Browser-based Terminal**: Full terminal access via [xterm.js](https://xtermjs.org) - no need for separate terminal windows
- **Session Persistence**: Sessions continue running even when you close the browser tab (tmux-like behavior)
- **Git Worktree Integration**: Create and delete git worktrees directly from the UI
- **Real-time Updates**: WebSocket-based notifications for session and worktree changes

## Architecture

```
Backend (Bun + Hono)               Frontend (React + Vite)
┌──────────────────────────┐       ┌──────────────────────────┐
│ Session Manager          │       │ Dashboard                │
│ ├── PTY Process 1       │◄─────►│ xterm.js Terminal        │
│ ├── PTY Process 2       │  WS   │ TanStack Router/Query    │
│ └── PTY Process N       │       │                          │
└──────────────────────────┘       └──────────────────────────┘
```

## Requirements

- [Bun](https://bun.sh) >= 1.3.0

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

## Standalone Distribution

The `dist/` directory can be distributed independently. Users only need to:

```bash
cd dist
bun install   # Installs only bun-pty (~few seconds)
bun start     # Starts the server
```

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
