import { useState } from 'react';
import {
  RegisterExistingPathForm,
  type RegisterExistingPathFormSubmitData,
} from './RegisterExistingPathForm';
import { CloneFromUrlForm } from './CloneFromUrlForm';

/**
 * Re-export of the existing-path submit payload so the dashboard route
 * (which owns the register-existing mutation) keeps a single import path.
 */
export type AddRepositoryFormSubmitData = RegisterExistingPathFormSubmitData;

const TABS = {
  clone: 'Clone from URL',
  existing: 'Use existing path',
} as const;

type TabId = keyof typeof TABS;

export interface AddRepositoryFormProps {
  isPending: boolean;
  /**
   * Handler for the "Use existing path" tab. Wires the existing
   * `POST /api/repositories` mutation. The "Clone from URL" tab is
   * self-contained (it calls `POST /api/repositories/clone` internally
   * and dismisses the dialog on success).
   */
  onSubmit: (data: AddRepositoryFormSubmitData) => Promise<void>;
  onCancel: () => void;
}

/**
 * Tabbed wrapper for the Register Repository dialog. Two tabs:
 *
 * 1. **Clone from URL** — the server clones into the shared source-repos
 *    directory and registers the resulting path. Self-contained: calls
 *    `POST /api/repositories/clone`, polls for status, and closes the
 *    dialog when the Clone Job succeeds. The newly-registered repository
 *    appears in the dashboard via the invalidated repositories list.
 * 2. **Use existing path** — delegates to the parent's `onSubmit` (the
 *    pre-existing register-existing-path flow). Unchanged behaviour.
 *
 * Default tab is "Clone from URL" since the clone flow eliminates the
 * host-side `git clone` step in multi-user setups.
 */
export function AddRepositoryForm({
  isPending,
  onSubmit,
  onCancel,
}: AddRepositoryFormProps) {
  const [activeTab, setActiveTab] = useState<TabId>('clone');

  const handleCloneSuccess = (_repositoryId: string) => {
    // The repository list cache is invalidated by `useCloneJobStatus`
    // when the Clone Job succeeds, so the new entry will appear on the
    // dashboard automatically. We just close the dialog; the dashboard
    // currently has no per-repository detail route, so no navigation
    // is required.
    onCancel();
  };

  return (
    <div className="card mb-5">
      <h2 className="mb-3 text-lg font-medium">Add Repository</h2>

      <div role="tablist" aria-label="Add repository method" className="flex border-b border-slate-700 mb-4">
        {(Object.entries(TABS) as [TabId, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`add-repo-tab-${id}`}
            id={`add-repo-tabbtn-${id}`}
            className={`px-4 py-2 text-sm whitespace-nowrap ${
              activeTab === id
                ? 'text-white border-b-2 border-blue-500'
                : 'text-slate-400 hover:text-white'
            }`}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'clone' && (
        <div
          role="tabpanel"
          id="add-repo-tab-clone"
          aria-labelledby="add-repo-tabbtn-clone"
        >
          <CloneFromUrlForm onSuccess={handleCloneSuccess} onCancel={onCancel} />
        </div>
      )}

      {activeTab === 'existing' && (
        <div
          role="tabpanel"
          id="add-repo-tab-existing"
          aria-labelledby="add-repo-tabbtn-existing"
        >
          <RegisterExistingPathForm
            isPending={isPending}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </div>
      )}
    </div>
  );
}
