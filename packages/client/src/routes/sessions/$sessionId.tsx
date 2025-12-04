import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/sessions/$sessionId')({
  component: TerminalPage,
});

function TerminalPage() {
  const { sessionId } = Route.useParams();

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      padding: '20px',
    }}>
      <h1 style={{ marginBottom: '20px', fontSize: '1.2rem' }}>
        Terminal - Session: {sessionId}
      </h1>
      <div style={{
        flex: 1,
        background: '#0d0d1a',
        borderRadius: '8px',
        padding: '20px',
        color: '#666',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        Terminal will be implemented in Phase 1
      </div>
    </div>
  );
}
