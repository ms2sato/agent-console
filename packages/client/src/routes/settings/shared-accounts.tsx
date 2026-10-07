import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SharedAccountSummary } from '@agent-console/shared';
import {
  fetchSharedAccounts,
  registerSharedAccount,
  unregisterSharedAccount,
} from '../../lib/api';
import { sharedAccountKeys } from '../../lib/query-keys';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { ErrorDialog, useErrorDialog } from '../../components/ui/error-dialog';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from '../../lib/auth';

export const Route = createFileRoute('/settings/shared-accounts')({
  component: SharedAccountsPage,
});

export function SharedAccountsPage() {
  const { authMode } = useAuth();

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Settings', to: '/settings' },
        { label: 'Shared Accounts' },
      ]} />

      <h1 className="text-2xl font-semibold mb-6">Shared Accounts</h1>

      {authMode === 'none' ? (
        <div className="card text-gray-500">
          <p>Shared accounts are only available in multi-user mode.</p>
        </div>
      ) : (
        <>
          <RegisterSharedAccountForm />
          <EnvVarIgnoredBanner />
          <SharedAccountsList />
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Register
// ===========================================================================

function RegisterSharedAccountForm() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const { errorDialogProps, showError } = useErrorDialog();

  const registerMutation = useMutation({
    mutationFn: registerSharedAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sharedAccountKeys.all() });
      setUsername('');
    },
    onError: (err) => {
      showError(
        'Cannot Register Shared Account',
        err instanceof Error ? err.message : 'Failed to register shared account',
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;
    registerMutation.mutate(trimmed);
  };

  return (
    <div className="card mb-6">
      <h2 className="text-lg font-medium mb-4">Register Shared Account</h2>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          className="input flex-1"
          placeholder="OS account username"
          aria-label="OS account username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={registerMutation.isPending}
        />
        <button
          type="submit"
          className="btn btn-primary text-sm"
          disabled={registerMutation.isPending || !username.trim()}
        >
          {registerMutation.isPending ? <Spinner size="sm" /> : 'Register'}
        </button>
      </form>
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}

// ===========================================================================
// Env-var-ignored banner (Release 2)
// ===========================================================================

/**
 * Warns the operator that `AGENT_CONSOLE_SHARED_USERNAME` is set on the
 * server but no longer consulted for session creation (Release 2 -- see
 * docs/design/shared-orchestrator-session.md's rollout table). Replaces the
 * Release 1 "Import current env-var account" affordance, which this release
 * removes entirely: once the registry no longer treats the env var as an
 * account source, importing from it would be the one remaining code path
 * that still reads the variable to pick an account.
 */
function EnvVarIgnoredBanner() {
  const { sharedAccountsEnvVarIgnored } = useAuth();

  if (!sharedAccountsEnvVarIgnored) {
    return null;
  }

  return (
    <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-600 rounded text-yellow-200 text-sm">
      AGENT_CONSOLE_SHARED_USERNAME is set but no longer used; register and bind accounts here, then remove it from the unit file.
    </div>
  );
}

// ===========================================================================
// List + unregister
// ===========================================================================

function SharedAccountsList() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: sharedAccountKeys.all(),
    queryFn: fetchSharedAccounts,
  });
  const [accountToUnregister, setAccountToUnregister] = useState<SharedAccountSummary | null>(null);
  const { errorDialogProps, showError } = useErrorDialog();

  const unregisterMutation = useMutation({
    mutationFn: unregisterSharedAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sharedAccountKeys.all() });
      setAccountToUnregister(null);
    },
    onError: (err) => {
      setAccountToUnregister(null);
      showError(
        'Cannot Unregister Shared Account',
        err instanceof Error ? err.message : 'Failed to unregister shared account',
      );
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <Spinner size="sm" />
        <span>Loading shared accounts...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card text-center py-10">
        <p className="text-red-400 mb-4">Failed to load shared accounts</p>
        <button onClick={() => refetch()} className="btn btn-primary">
          Retry
        </button>
      </div>
    );
  }

  const accounts = data?.accounts ?? [];

  if (accounts.length === 0) {
    return (
      <div className="card text-center py-10">
        <p className="text-gray-500">No shared accounts registered yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {accounts.map((account) => {
        const inUse = account.boundRepositoryCount > 0 || account.sessionCount > 0;
        return (
          <div key={account.username} className="card flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-lg font-medium flex items-center gap-2">
                {account.username}
                {!account.resolvable && (
                  <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-red-900/40 text-red-300">
                    unresolvable
                  </span>
                )}
              </div>
              <div className="text-sm text-gray-500">
                {account.boundRepositoryCount} repositor{account.boundRepositoryCount === 1 ? 'y' : 'ies'} ·{' '}
                {account.sessionCount} session{account.sessionCount === 1 ? '' : 's'}
              </div>
            </div>
            <button
              onClick={() => setAccountToUnregister(account)}
              disabled={inUse}
              title={
                inUse
                  ? 'Cannot unregister: still bound to a repository or still has active sessions'
                  : undefined
              }
              className="btn btn-danger text-sm shrink-0"
            >
              Unregister
            </button>
          </div>
        );
      })}

      <ConfirmDialog
        open={accountToUnregister !== null}
        onOpenChange={(open) => !open && setAccountToUnregister(null)}
        title="Unregister Shared Account"
        description={`Are you sure you want to unregister "${accountToUnregister?.username}"?`}
        confirmLabel="Unregister"
        variant="danger"
        onConfirm={() => {
          if (accountToUnregister) {
            unregisterMutation.mutate(accountToUnregister.username);
          }
        }}
        isLoading={unregisterMutation.isPending}
      />
      <ErrorDialog {...errorDialogProps} />
    </div>
  );
}
