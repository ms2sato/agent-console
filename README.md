# Agent Console

> **Note**: Currently only tested on macOS.

A web application for managing multiple AI coding agent instances running in different git worktrees. Control all your agents through a unified browser interface instead of scattered terminal windows.

Currently supports **Claude Code** as the default agent, with plans to support additional agents (Gemini CLI, Codex, etc.) in the future.

## Features

- **Unified Dashboard**: View and manage all repositories, worktrees, and agent sessions in one place
- **Browser-based Terminal**: Full terminal access via xterm.js - no need for separate terminal windows
- **Session Persistence**: Sessions continue running even when you close the browser tab (tmux-like behavior)
- **Git Worktree Integration**: Create and delete git worktrees directly from the UI
- **Real-time Updates**: WebSocket-based notifications for session and worktree changes

## Architecture

```
Backend (Node.js + Hono)           Frontend (React + Vite)
┌──────────────────────────┐       ┌──────────────────────────┐
│ Session Manager          │       │ Dashboard                │
│ ├── PTY Process 1       │◄─────►│ xterm.js Terminal        │
│ ├── PTY Process 2       │  WS   │ TanStack Router/Query    │
│ └── PTY Process N       │       │                          │
└──────────────────────────┘       └──────────────────────────┘
```

## Requirements

- Node.js >= 22.0.0
- pnpm >= 9.0.0

## Development

### Setup

```bash
# Install dependencies
pnpm install

# Start development servers (frontend + backend)
pnpm dev
```

The development server runs at:
- Frontend: http://localhost:5173
- Backend: http://localhost:3457

### Build

```bash
pnpm build
```

This creates a production bundle in the `dist/` directory:

```
dist/
├── package.json    # Standalone package manifest
├── index.js        # Bundled server (ESM)
└── public/         # Built frontend assets
```

### Production

```bash
# From the project root (after build)
pnpm start
```

Or run directly:

```bash
NODE_ENV=production node dist/index.js
```

The server runs at http://localhost:3457

## Standalone Distribution

The `dist/` directory can be distributed independently. Users only need to:

```bash
cd dist
npm install   # Installs only node-pty and ws (~few seconds)
npm start     # Starts the server
```

### Why these dependencies aren't bundled

- **node-pty**: Native module with C++ bindings - must be compiled for the target platform
- **ws**: Uses CommonJS dynamic require which can't be bundled into ESM

All other dependencies (hono, uuid, etc.) are bundled into `index.js`.

## Project Structure

```
agent-console/
├── packages/
│   ├── client/          # React frontend
│   ├── server/          # Hono backend
│   └── shared/          # Shared TypeScript types
├── dist/                # Production build output
├── poc/                 # Proof-of-concept files
└── design.md            # Design documentation (Japanese)
```

## Tech Stack

- **Backend**: Node.js, TypeScript, Hono, node-pty, ws
- **Frontend**: React, TypeScript, Vite, TanStack Router, TanStack Query, xterm.js, Tailwind CSS
- **Build**: esbuild (server bundling), Vite (frontend)
- **Package Manager**: pnpm workspaces

## License

MIT
