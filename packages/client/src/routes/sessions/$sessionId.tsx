import { createFileRoute } from '@tanstack/react-router';
import { Terminal } from '../../components/Terminal';

interface TerminalSearchParams {
  cwd?: string;
}

export const Route = createFileRoute('/sessions/$sessionId')({
  component: TerminalPage,
  validateSearch: (search: Record<string, unknown>): TerminalSearchParams => {
    return {
      cwd: typeof search.cwd === 'string' ? search.cwd : undefined,
    };
  },
});

function TerminalPage() {
  const { sessionId } = Route.useParams();
  const { cwd } = Route.useSearch();

  // For 'new' session, use the /ws/terminal-new endpoint
  // For existing sessions, use /ws/terminal/:sessionId
  const wsUrl = sessionId === 'new'
    ? `ws://${window.location.hostname}:3457/ws/terminal-new${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
    : `ws://${window.location.hostname}:3457/ws/terminal/${sessionId}`;

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <Terminal wsUrl={wsUrl} />
    </div>
  );
}
