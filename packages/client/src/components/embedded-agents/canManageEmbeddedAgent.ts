/**
 * Whether the current viewer may edit/delete an `EmbeddedAgentDefinition`.
 *
 * In single-user mode, `useAuth().currentUser` is never populated
 * (`main.tsx`'s `initApp()` only calls `fetchCurrentUser()` /
 * `setCurrentUser()` for `authMode === 'multi-user'`, by design -- see
 * `LogoutButton` in `NavLinks.tsx`, which relies on `currentUser === null`
 * to decide whether to render). So a plain `createdBy === currentUser?.id`
 * comparison always evaluates false in single-user mode, hiding Edit/Delete
 * for everyone -- even the definition's own creator.
 *
 * Ownership is trivially satisfied in single-user mode (sole user), matching
 * the server's own check: `PATCH`/`DELETE /api/embedded-agents/:id`
 * (`packages/server/src/routes/embedded-agents.ts`) compares against a
 * fixed synthetic user in single-user mode, so it also always passes there.
 * See "Ownership" in docs/design/embedded-agent-worker.md.
 */
export function canManageEmbeddedAgent(
  createdBy: string,
  currentUserId: string | null | undefined,
  isMultiUser: boolean
): boolean {
  return !isMultiUser || createdBy === currentUserId;
}
