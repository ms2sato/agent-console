# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A web application for managing multiple Claude Code instances running in different git worktrees. Instead of scattered terminals, users control all instances through a unified browser interface using xterm.js.

## Architecture

```
Backend (Node.js)              Frontend (Browser)
┌─────────────────────┐        ┌─────────────────────┐
│ sessions Map        │        │ xterm.js terminal   │
│ ├── WT1: {pty}     │◄──────►│ WebSocket client    │
│ ├── WT2: {pty}     │   WS   │                     │
│ └── WT3: {pty}     │        │                     │
└─────────────────────┘        └─────────────────────┘
```

- **Backend** manages PTY processes that persist across browser reconnections (tmux-like)
- **Frontend** is vanilla JS with xterm.js via CDN (no framework)
- **WebSocket** protocol for bidirectional terminal I/O

## Key Technical Details

- Claude Code requires PTY (not regular spawn) because it's an interactive TUI
- xterm.js handles ANSI escape sequences from Claude Code
- Resize events must be propagated to PTY (`claude.resize(cols, rows)`)
- Output buffering enables reconnection without losing history

## Running the PoC

```bash
node poc-xterm-server.js /path/to/git/repo
# Opens on http://localhost:3457
```

## Project Files

- `poc-pty.js` - Direct PTY control (CLI mode)
- `poc-xterm-server.js` - WebSocket server serving xterm.js client
- `poc-xterm.html` - Browser UI with xterm.js

## WebSocket Message Protocol

Client → Server:
- `{ type: 'input', data: string }` - Terminal input
- `{ type: 'resize', cols: number, rows: number }` - Terminal resize

Server → Client:
- `{ type: 'output', data: string }` - PTY output
- `{ type: 'exit', exitCode: number, signal: string }` - Process exit
- `{ type: 'history', data: string }` - Buffered output on reconnect

## Dependencies

- `node-pty` - Pseudo-terminal for spawning Claude Code
- `ws` - WebSocket server
- xterm.js loaded from CDN (v5.3.0)
