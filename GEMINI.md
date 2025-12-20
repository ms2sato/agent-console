# Project Overview

This is a TypeScript monorepo for a web application called "Agent Console." It's designed to manage multiple AI coding agent instances running in different git worktrees. The application features a unified dashboard, a browser-based terminal, session persistence, and git worktree integration. The backend is built with Bun and Hono, while the frontend uses React and Vite.

## Building and Running

**Development:**

To run the development servers for both the frontend and backend, use the following command:

```bash
bun dev
```

-   Frontend: `http://localhost:5173`
-   Backend: `http://localhost:3457`

**Build:**

To create a production build, run:

```bash
bun run build
```

This will generate a `dist/` directory containing the bundled server and frontend assets.

**Production:**

To start the server in production mode, use:

```bash
bun start
```

## Development Conventions

-   **TypeScript:** The project uses TypeScript with strict mode enforced.
-   **Testing:** Tests are written with `bun test`. Integration-style tests and communication-layer mocks are preferred.
-   **Commits:** Commit messages follow the conventional style (`feat:`, `fix:`, `refactor:`, etc.).
-   **AI-Driven Development:** A significant portion of the codebase is written by AI agents, with humans providing high-level direction and final approval.
-   **Code Style:** The project uses 2-space indentation and prefers named exports.
-   **Schema Validation:** Valibot is used for schema validation, with a convention to use `minLength(1)` before regex validation.
-   **Monorepo Structure:** The project is organized as a monorepo with `packages/client`, `packages/server`, and `packages/shared` workspaces.
-   **Package Manager:** The project uses `bun` for package management and `pnpm` for lockfile compatibility.
