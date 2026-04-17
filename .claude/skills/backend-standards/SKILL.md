---
name: backend-standards
description: Detailed backend patterns and code examples for server implementation. Use when you need step-by-step guidance or concrete code patterns beyond what the auto-loaded backend rules provide.
---

# Backend Standards (Procedural Guide)

> **Note:** Declarative rules (conventions, directory structure, naming) are in `.claude/rules/backend.md` and auto-loaded for `packages/server/**`. This skill provides detailed code examples and patterns.

## Detailed Documentation

- [backend-standards.md](backend-standards.md) — procedural detail and code patterns beyond the rule: Dependency Injection Policy, Hono framework patterns (routes, Valibot validation, error handling), structured logging examples, async patterns (route handlers, callbacks, process-level), callback lifecycle, resource cleanup worked example, PTY output buffering, async-over-sync exceptions and examples, WebSocket message typing.
- [websocket-patterns.md](websocket-patterns.md) — WebSocket implementation details: dual architecture setup, message protocol types, broadcast implementation, output buffering.
- [webhook-receiver-patterns.md](webhook-receiver-patterns.md) — webhook receiver implementation: always-200 pattern, async processing, signature verification, error handling strategy.
