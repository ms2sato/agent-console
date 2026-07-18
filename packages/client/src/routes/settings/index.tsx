import { createFileRoute, Link } from '@tanstack/react-router';
import { PageBreadcrumb } from '../../components/PageBreadcrumb';
import { McpInstallSection } from '../../components/settings/McpInstallSection';

export const Route = createFileRoute('/settings/')({
  component: SettingsPage,
});

export function SettingsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <PageBreadcrumb items={[
        { label: 'Agent Console', to: '/' },
        { label: 'Settings' },
      ]} />

      <McpInstallSection />

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
    </div>
  );
}

