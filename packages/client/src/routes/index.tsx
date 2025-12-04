import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const [cwd, setCwd] = useState('');

  const handleStartSession = () => {
    // Navigate to terminal with query param for cwd
    // The terminal page will create a new session
    navigate({
      to: '/sessions/$sessionId',
      params: { sessionId: 'new' },
      search: cwd ? { cwd } : undefined,
    });
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ marginBottom: '20px', fontSize: '1.5rem' }}>Dashboard</h1>

      <div style={{
        marginBottom: '40px',
        padding: '20px',
        border: '1px solid #333',
        borderRadius: '8px',
        background: '#0d0d1a',
      }}>
        <h2 style={{ marginBottom: '16px', fontSize: '1.1rem' }}>Start New Session</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Working directory (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={{
              flex: 1,
              padding: '8px 12px',
              background: '#1a1a2e',
              border: '1px solid #444',
              borderRadius: '4px',
              color: '#eee',
              fontSize: '0.875rem',
            }}
          />
          <button
            onClick={handleStartSession}
            style={{
              padding: '8px 20px',
              background: '#4a4a6a',
              border: 'none',
              borderRadius: '4px',
              color: '#eee',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Start Claude Code
          </button>
        </div>
        <p style={{ marginTop: '8px', color: '#666', fontSize: '0.75rem' }}>
          Leave empty to use the server&apos;s current directory
        </p>
      </div>

      <div style={{
        padding: '20px',
        border: '1px dashed #444',
        borderRadius: '8px',
        color: '#666',
      }}>
        Phase 1 - Single session implementation in progress.
        <br />
        Session list will be shown here in Phase 2.
      </div>
    </div>
  );
}
