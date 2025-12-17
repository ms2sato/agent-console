---
name: frontend-standards
description: React patterns and frontend best practices for this project. Use when implementing React components, hooks, routes, styling, or client-side logic in packages/client.
---

# Frontend Standards

Refer to [frontend-standards.md](frontend-standards.md) for detailed patterns.

## Key Principles

- **Avoid useEffect** - Use TanStack Query, useSyncExternalStore, or event handlers instead
- **Prefer Suspense** - For loading states and async boundaries
- **useSyncExternalStore** - For external state subscriptions (WebSocket, global stores)
- **Server is the source of truth** - Don't maintain conflicting client state

## Tech Stack

- React 18, TanStack Router, TanStack Query, Tailwind CSS, xterm.js, Valibot
