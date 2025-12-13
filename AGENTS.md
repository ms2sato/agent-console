# Repository Guidelines

## Project Structure & Module Organization
- Root uses Bun workspaces; run commands from the repo root unless noted.
- `packages/client/`: React + Vite UI (routes in `src/routes`, components/tests in `src/components` and `src/components/__tests__`).
- `packages/server/`: Bun + Hono API/websocket server, services under `src/services`, tests in `src/services/__tests__` and `src/lib/__tests__`.
- `packages/shared/`: TypeScript types/Valibot schemas consumed by client and server.
- `docs/`: Design/testing notes; `scripts/`: deployment helpers; `dist/`: built server bundle and static assets (generated).

## Build, Test, and Development Commands
- Install: `bun install` (workspace-aware).
- Dev (full stack): `bun dev` (runs filtered workspace dev scripts; frontend at 5173, backend at 3457).
- Build: `bun run build` (shared → client → server; outputs to `dist/`).
- Prod run after build: `bun start` or `NODE_ENV=production bun dist/index.js`.
- Type checks: `bun run typecheck` (all workspaces).
- Tests: `bun run test` for full suite; `bun run test:only` skips typecheck; workspace-specific `bun run --filter '@agent-console/server' test`, etc.

## Coding Style & Naming Conventions
- TypeScript everywhere; `tsconfig.base.json` enforces strict mode and no unuseds.
- Indent with 2 spaces; prefer named exports from module entry points.
- React components/hooks use PascalCase filenames (`SessionSettings.tsx`, `useDashboardWebSocket.ts`); tests mirror sources with `.test.ts`/`.test.tsx` in `__tests__` or alongside modules.
- Shared schemas/types live in `packages/shared/src`; keep API contracts there to avoid duplication.

## Testing Guidelines
- Default to `bun test`; client tests preload `src/test/setup.ts` (happy-dom + RTL); server/shared tests live under `__tests__`.
- Favor integration-style tests and communication-layer mocks (fetch/WebSocket/FS); avoid module-level mocks unless unavoidable—see `docs/testing-guidelines.md`.
- Forms need component-level tests to cover React Hook Form + Valibot wiring; add cases for hidden/conditional fields.

## Commit & Pull Request Guidelines
- Follow the existing conventional style seen in history (`feat:`, `fix:`, `refactor:`, etc.); write imperative, scoped messages.
- Include PR descriptions with context, linked issues, and risk notes; add screenshots/GIFs for UI changes and API notes for server changes.
- Run `bun run typecheck` and relevant `bun run test` before raising a PR; paste failures and rationale if something must be skipped.
