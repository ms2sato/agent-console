---
name: backend-standards
description: Hono/Bun patterns and backend best practices for this project. Use when implementing API endpoints, WebSocket handlers, services, or server-side logic in packages/server.
---

# Backend Standards

Refer to [backend-standards.md](backend-standards.md) for detailed patterns.

## Key Principles

- **Server is the source of truth** - Backend manages all session/worker state
- **Structured logging** - Use Pino with context objects
- **Resource cleanup** - Always clean up PTY processes and connections
- **Type safety** - Define types in shared package, validate at boundaries

## Tech Stack

- Bun, Hono, bun-pty, Pino, Valibot
