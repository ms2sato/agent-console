import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SharedAccountSummary } from '@agent-console/shared';
import {
  fetchSharedAccounts,
  registerSharedAccount,
  unregisterSharedAccount,
  importEnvSharedAccount,
  NO_ENV_SHARED_ACCOUNT_ERROR_MESSAGE,
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
          <ImportEnvAccountSection />
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
// Import env-var account
// ===========================================================================

function ImportEnvAccountSection() {
  const { sharedAccountsAvailable } = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'success' | 'info' | 'error'; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const importMutation = useMutation({
    mutationFn: importEnvSharedAccount,
    onMutate: () => {
      setMessage(null);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    onSuccess: (result) => {
      if (result.imported) {
        queryClient.invalidateQueries({ queryKey: sharedAccountKeys.all() });
        setMessage({ kind: 'success', text: 'Imported the env-var shared account.' });
      } else {
        setMessage({ kind: 'info', text: 'The env-var shared account is already registered.' });
      }
      timerRef.current = setTimeout(() => setMessage(null), 5000);
    },
    onError: (err) => {
      const text =
        err instanceof Error && err.message === NO_ENV_SHARED_ACCOUNT_ERROR_MESSAGE
          ? 'No env-var shared account is configured.'
          : err instanceof Error
            ? err.message
            : 'Failed to import env-var shared account';
      setMessage({ kind: 'error', text });
      timerRef.current = setTimeout(() => setMessage(null), 5000);
    },
  });

  // Gated on `sharedAccountsAvailable` (env-var registry presence), matching
  // the gating already used by QuickSessionForm/CreateWorktreeForm's shared-
  // session checkbox -- this affordance is specifically about importing THAT
  // env-var account, not about shared accounts in general.
  if (!sharedAccountsAvailable) {
    return null;
  }

  return (
    <div className="card mb-6">
      <h2 className="text-lg font-medium mb-2">Import Current Env-Var Account</h2>
      <p className="text-sm text-gray-500 mb-4">
        Register the shared account configured via AGENT_CONSOLE_SHARED_USERNAME into the DB-backed registry.
      </p>
      <button
        onClick={() => importMutation.mutate()}
        disabled={importMutation.isPending}
        className="btn bg-slate-600 hover:bg-slate-500 text-sm"
      >
        {importMutation.isPending ? <Spinner size="sm" /> : 'Import current env-var account'}
      </button>
      {message && (
        <p
          className={`text-sm mt-2 ${
            message.kind === 'error'
              ? 'text-red-400'
              : message.kind === 'success'
                ? 'text-green-400'
                : 'text-gray-400'
          }`}
        >
          {message.text}
        </p>
      )}
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
              <div className="text-lg font-medium">{account.username}</div>
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
