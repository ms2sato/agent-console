import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCurrentUser, updateAuthPreferences } from '../../lib/api';
import { authKeys } from '../../lib/query-keys';
import { logger } from '../../lib/logger';

/**
 * Settings-page section exposing a per-user toggle for claude.ai connectors
 * (Google Drive, Gmail, ...) on this user's `claude-sdk` embedded-agent
 * workers. Terminal Claude Code workers are unaffected.
 *
 * Deliberately does NOT read `useAuth().currentUser` — that hook is always
 * `null` in single-user mode (see `main.tsx`'s boot flow and
 * `canManageEmbeddedAgent.ts`'s doc comment), and this toggle must work in
 * single-user mode too. Instead it owns its own `GET /api/auth/me` read via
 * TanStack Query, independent of the app's boot-time auth state.
 */
export function ConnectorsSection() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: authKeys.me(),
    queryFn: fetchCurrentUser,
  });

  const mutation = useMutation({
    mutationFn: updateAuthPreferences,
    onSuccess: (response) => {
      queryClient.setQueryData(authKeys.me(), response);
    },
  });

  if (!data?.preferences) return null;

  const disableClaudeAiConnectors = data.preferences.disableClaudeAiConnectors;

  const handleChange = async (checked: boolean) => {
    try {
      await mutation.mutateAsync({ disableClaudeAiConnectors: checked });
    } catch (err) {
      logger.error('Failed to update connectors preference:', err);
    }
  };

  return (
    <div className="card mb-6">
      <h2 className="text-lg font-medium mb-2">Claude.ai connectors</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={disableClaudeAiConnectors}
          disabled={mutation.isPending}
          onChange={(e) => void handleChange(e.target.checked)}
        />
        <span>
          Disable claude.ai connectors in my embedded claude-sdk workers
        </span>
      </label>
      <p className="text-sm text-gray-500 mt-2">
        Applies the next time a worker starts. Connectors are your Anthropic
        account&apos;s own integrations (Google Drive, Gmail, ...); terminal
        Claude Code workers are not affected.
      </p>
      {mutation.isError && (
        <p className="text-sm text-red-400 mt-2">Failed to update the connectors preference.</p>
      )}
    </div>
  );
}
