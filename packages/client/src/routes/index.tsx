import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ marginBottom: '20px', fontSize: '1.5rem' }}>Dashboard</h1>
      <p style={{ color: '#888' }}>
        Welcome to Claude Code Web Console.
        This is the dashboard where you will manage repositories, worktrees, and sessions.
      </p>
      <div style={{
        marginTop: '40px',
        padding: '20px',
        border: '1px dashed #444',
        borderRadius: '8px',
        color: '#666',
      }}>
        Phase 0 complete - Project structure is ready.
        <br />
        Next: Phase 1 - Single session implementation
      </div>
    </div>
  );
}
