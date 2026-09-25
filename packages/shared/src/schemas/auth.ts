import * as v from 'valibot';

/**
 * Schema for login request payload.
 * Validates that both username and password are non-empty strings.
 */
export const LoginRequestSchema = v.strictObject({
  username: v.pipe(v.string(), v.minLength(1, 'Username is required')),
  password: v.pipe(v.string(), v.minLength(1, 'Password is required')),
});

export type LoginRequest = v.InferOutput<typeof LoginRequestSchema>;

/**
 * Schema for `GET /api/config`'s response.
 *
 * Returned to the client before authentication so the client can decide
 * whether to render auth UI and which optional features to surface.
 *
 * `sharedAccountsAvailable` is a boolean gate for shared-session UI; the
 * underlying set of shared-account user-ids is intentionally NOT exposed
 * (per docs/design/shared-orchestrator-session.md §UI). Per-session
 * `Session.isShared` is the safe abstraction for client rendering.
 *
 * `ConfigResponse` is derived from this schema (below) via `v.InferOutput`
 * so the two cannot drift (pre-pr-completeness.md Q10). It lives here, not
 * in `packages/shared/src/types/auth.ts`, because `types/` may not import
 * from `schemas/` (see `.dependency-cruiser.cjs`'s `shared-no-types-import-schemas`
 * rule) -- a schema-derived type stays alongside its schema.
 */
export const ConfigResponseSchema = v.strictObject({
  homeDir: v.string(),
  capabilities: v.strictObject({
    /**
     * Whether the "Open in VS Code" UI should be surfaced to the user.
     * Semantics depend on `vscodeOpenMode`:
     * - `local-spawn`: `true` iff a `code` / `code-insiders` binary exists on
     *   the server host.
     * - `remote-url-scheme`: always `true` (the client's local VS Code handles
     *   the URL scheme, so the server's binary presence is irrelevant).
     */
    vscode: v.boolean(),
    /** Mirrors `VSCodeOpenMode` (packages/shared/src/types/auth.ts). */
    vscodeOpenMode: v.picklist(['local-spawn', 'remote-url-scheme']),
    /**
     * Host to embed in the `vscode://vscode-remote/ssh-remote+HOST<path>` URL
     * when `vscodeOpenMode === 'remote-url-scheme'`. `null` means the client
     * falls back to `window.location.hostname`.
     */
    vscodeRemoteHost: v.nullable(v.string()),
  }),
  serverPid: v.number(),
  /**
   * Backend HTTP port the server is bound to.
   *
   * Exposed so the client can compose absolute URLs to the same server
   * (e.g. the MCP endpoint shown by the "install MCP" UI) without hard-coding
   * a port that may differ between environments or worktrees.
   */
  serverPort: v.number(),
  /** Mirrors `AuthMode` (packages/shared/src/types/auth.ts). */
  authMode: v.picklist(['none', 'multi-user']),
  sharedAccountsAvailable: v.boolean(),
  /**
   * SHA of the commit currently deployed at this instance, or `null` when no
   * `.deploy-sha` marker is present (e.g. `bun run dev`). See
   * `readDeployedSha` (packages/server/src/lib/deployed-sha.ts).
   */
  deployedSha: v.nullable(v.string()),
});

export type ConfigResponse = v.InferOutput<typeof ConfigResponseSchema>;

/**
 * Schema for `PATCH /api/auth/me/preferences`'s request body.
 *
 * Mirrors `packages/shared/src/types/auth.ts`'s hand-written `UserPreferences`
 * domain type field-for-field, but is independently defined here (same
 * reason `ConfigResponseSchema` above lives here rather than in
 * `types/auth.ts`: `.dependency-cruiser.cjs`'s `shared-no-types-import-schemas`
 * rule forbids `types/` importing from `schemas/`) -- this is the wire
 * boundary validated at parse time, not a re-export of the domain shape.
 * `v.strictObject` rejects any field beyond `disableClaudeAiConnectors`
 * (in particular, no `id`/`userId` field is ever accepted here -- the
 * target user always comes from the authenticated caller, never the body).
 */
export const MePreferencesSchema = v.strictObject({
  disableClaudeAiConnectors: v.boolean(),
});

export type MePreferencesRequest = v.InferOutput<typeof MePreferencesSchema>;
