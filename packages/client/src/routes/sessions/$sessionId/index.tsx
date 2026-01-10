import { createFileRoute } from '@tanstack/react-router';
import { SessionPage } from '../../../components/sessions/SessionPage';

export const Route = createFileRoute('/sessions/$sessionId/')({
  component: SessionIndexPage,
});

/**
 * Route: /sessions/:sessionId
 *
 * This route handles the base session URL without a workerId.
 * The SessionPage component will automatically redirect to the default worker
 * (first agent worker or first available worker).
 */
function SessionIndexPage() {
  const { sessionId } = Route.useParams();

  return <SessionPage sessionId={sessionId} />;
}
