---
name: frontend-standards
description: Detailed React patterns and code examples for frontend implementation. Use when you need step-by-step guidance or concrete code patterns beyond what the auto-loaded frontend rules provide.
---

# Frontend Standards (Procedural Guide)

> **Note:** Declarative rules (conventions, directory structure, naming) are in `.claude/rules/frontend.md` and auto-loaded for `packages/client/**`. This skill provides detailed code examples and patterns.

## Detailed Documentation

- [frontend-standards.md](frontend-standards.md) — agent-console-specific frontend patterns: TanStack Router/Query usage, xterm.js integration, Tailwind conventions, Valibot form pitfalls, Browser Verification procedure for UI changes.
- [react-patterns.md](react-patterns.md) — generic React patterns with full code examples: `useSyncExternalStore` for external stores, Suspense for async, async/await in event handlers, async useEffect with cleanup flag, icon component extraction.

The two files are non-overlapping. When a topic is generic React, it lives in `react-patterns.md`; when it is specific to agent-console's stack, it lives in `frontend-standards.md`.

See also: `ux-design-standards` skill for UX design principles that guide feature-level decisions.
