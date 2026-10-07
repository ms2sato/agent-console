import { createFileRoute, Link } from '@tanstack/react-router';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { McpInstallSection } from '../../components/settings/McpInstallSection';
import { ConnectorsSection } from '../../components/settings/ConnectorsSection';
import { useAuth } from '../../lib/auth';

export const Route = createFileRoute('/settings/')({
  component: SettingsPage,
});

export function SettingsPage() {
  const { authMode } = useAuth();

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Settings' },
      ]} />

      <McpInstallSection />

      <ConnectorsSection />

      <h1 className="text-2xl font-semibold mb-6">Settings</h1>

      {/* Agent management moved to the Agents page */}
      <div className="card text-gray-500">
        <p>
          Agent management has moved to the{' '}
          <Link to="/agents" className="text-blue-400 hover:underline">
            Agents page
          </Link>
          . Head there to add, edit, or remove terminal and embedded agents.
        </p>
      </div>

      {/* Shared accounts are a multi-user-only concept; hide the link entirely
          when AUTH_MODE=none rather than linking to a page that would just
          say "not available". */}
      {authMode !== 'none' && (
        <div className="card text-gray-500 mt-4">
          <p>
            Manage{' '}
            <Link to="/settings/shared-accounts" className="text-blue-400 hover:underline">
              Shared Accounts
            </Link>
            {' '}used to run sessions under a shared OS account.
          </p>
        </div>
      )}
    </div>
  );
}

